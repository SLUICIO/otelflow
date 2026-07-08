// Package validate performs semantic validation of OpenTelemetry Collector
// configurations against a version-aware component registry. It returns
// structured diagnostics with line/column positions taken from the YAML AST.
package validate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/sluicio/otelflow/internal/registry"
)

type Severity string

const (
	SevError   Severity = "error"
	SevWarning Severity = "warning"
	SevInfo    Severity = "info"
)

type Diagnostic struct {
	Severity Severity `json:"severity"`
	Message  string   `json:"message"`
	Path     string   `json:"path,omitempty"`
	Line     int      `json:"line,omitempty"`
	Column   int      `json:"column,omitempty"`
	Hint     string   `json:"hint,omitempty"`
}

type Result struct {
	Valid       bool         `json:"valid"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

var sectionKinds = map[string]registry.Kind{
	"receivers":  registry.KindReceiver,
	"processors": registry.KindProcessor,
	"exporters":  registry.KindExporter,
	"extensions": registry.KindExtension,
	"connectors": registry.KindConnector,
}

var knownTopLevel = map[string]bool{
	"receivers": true, "processors": true, "exporters": true,
	"extensions": true, "connectors": true, "service": true,
}

var componentIDRe = regexp.MustCompile(`^[a-zA-Z][0-9a-zA-Z_]*(/.*)?$`)

// connectorsMinVersion is when connectors became a supported top-level
// section in the service config.
const connectorsMinVersion = "0.71.0"

type validator struct {
	reg     *registry.Registry
	version string
	diags   []Diagnostic

	// defined[kind][fullID] -> key node, for reference checks and
	// unused-component warnings.
	defined map[registry.Kind]map[string]*yaml.Node
	used    map[registry.Kind]map[string]bool

	// connector role usage: connectors must appear as exporter in one
	// pipeline and receiver in another.
	connAsExporter map[string]bool
	connAsReceiver map[string]bool
	connNodes      map[string]*yaml.Node
}

// Validate checks a raw YAML collector config against the registry for the
// given collector version.
func Validate(reg *registry.Registry, configYAML, version string) Result {
	v := &validator{
		reg:            reg,
		version:        version,
		defined:        map[registry.Kind]map[string]*yaml.Node{},
		used:           map[registry.Kind]map[string]bool{},
		connAsExporter: map[string]bool{},
		connAsReceiver: map[string]bool{},
		connNodes:      map[string]*yaml.Node{},
	}
	for _, k := range sectionKinds {
		v.defined[k] = map[string]*yaml.Node{}
		v.used[k] = map[string]bool{}
	}

	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(configYAML), &doc); err != nil {
		v.addYAMLError(err)
		return v.result()
	}
	root := unwrapDoc(&doc)
	if root == nil || root.Kind == 0 || (root.Kind == yaml.ScalarNode && strings.TrimSpace(root.Value) == "") {
		v.add(SevInfo, "Configuration is empty — paste an OpenTelemetry Collector config to get started.", "", nil, "")
		return v.result()
	}
	if root.Kind != yaml.MappingNode {
		v.add(SevError, "The top level of a collector configuration must be a mapping.", "", root, "")
		return v.result()
	}

	var serviceNode *yaml.Node
	forEachEntry(root, func(key, val *yaml.Node) {
		name := key.Value
		switch {
		case name == "service":
			serviceNode = val
		case sectionKinds[name] != "":
			if name == "connectors" && registry.CompareVersions(version, connectorsMinVersion) < 0 {
				v.add(SevError,
					fmt.Sprintf("The 'connectors' section is not supported in collector v%s.", version),
					"connectors", key,
					fmt.Sprintf("Connectors were introduced in v%s. Select a newer collector version or remove the section.", connectorsMinVersion))
			}
			v.checkComponentSection(name, sectionKinds[name], val)
		default:
			if !knownTopLevel[name] {
				v.add(SevWarning, fmt.Sprintf("Unknown top-level section '%s'.", name), name, key,
					"Expected one of: receivers, processors, exporters, extensions, connectors, service.")
			}
		}
	})

	if serviceNode == nil {
		v.add(SevError, "Missing required 'service' section.", "", root,
			"Every collector config needs a service section with at least one pipeline.")
	} else {
		v.checkService(serviceNode)
	}

	v.checkUnused()
	v.checkConnectorRoles()
	return v.result()
}

func (v *validator) checkComponentSection(section string, kind registry.Kind, node *yaml.Node) {
	node = resolve(node)
	if node == nil || node.Tag == "!!null" {
		return
	}
	if node.Kind != yaml.MappingNode {
		v.add(SevError, fmt.Sprintf("'%s' must be a mapping of component IDs to configurations.", section), section, node, "")
		return
	}
	forEachEntry(node, func(key, val *yaml.Node) {
		id := key.Value
		path := section + "." + id
		if !componentIDRe.MatchString(id) {
			v.add(SevError, fmt.Sprintf("Invalid component ID '%s'.", id), path, key,
				"Component IDs have the form 'type' or 'type/name', e.g. 'otlp' or 'otlp/internal'.")
			return
		}
		if _, dup := v.defined[kind][id]; dup {
			v.add(SevError, fmt.Sprintf("Duplicate %s ID '%s'.", kind, id), path, key, "")
		}
		v.defined[kind][id] = key

		typeName := componentType(id)
		comp := v.reg.Find(kind, typeName)
		if comp == nil {
			hint := v.unknownTypeHint(kind, typeName)
			v.add(SevError, fmt.Sprintf("Unknown %s type '%s'.", kind, typeName), path, key, hint)
			return
		}
		if !comp.AvailableIn(v.version) {
			if comp.Removed != "" && registry.CompareVersions(v.version, comp.Removed) >= 0 {
				v.add(SevError,
					fmt.Sprintf("The %s '%s' was removed in v%s and does not exist in v%s.", kind, typeName, comp.Removed, v.version),
					path, key, removalHint(comp))
			} else {
				v.add(SevError,
					fmt.Sprintf("The %s '%s' is not available in v%s (added in v%s).", kind, typeName, v.version, comp.Added),
					path, key, fmt.Sprintf("Select collector version v%s or newer to use it.", comp.Added))
			}
			return
		}
		if comp.DeprecatedIn(v.version) {
			v.add(SevWarning,
				fmt.Sprintf("The %s '%s' is deprecated since v%s.", kind, typeName, comp.Deprecated),
				path, key, removalHint(comp))
		}
		if len(comp.Schema) > 0 {
			v.checkAgainstSchema(comp.Schema, val, path)
		}
	})
}

// removalHint suggests the replacement for well-known deprecations.
func removalHint(c *registry.Component) string {
	switch {
	case c.Kind == registry.KindExporter && c.Type == "logging":
		return "Use the 'debug' exporter instead."
	case c.Kind == registry.KindExporter && c.Type == "jaeger":
		return "Jaeger accepts OTLP natively — use the 'otlp' exporter pointed at your Jaeger endpoint."
	case c.Kind == registry.KindExtension && c.Type == "memory_ballast":
		return "Use the GOMEMLIMIT environment variable instead."
	}
	if c.Removed != "" {
		return fmt.Sprintf("It was removed in v%s.", c.Removed)
	}
	return ""
}

func (v *validator) unknownTypeHint(kind registry.Kind, typeName string) string {
	// 'sluicio' is a designer preset, not a real collector component.
	if kind == registry.KindExporter && typeName == "sluicio" {
		return "Sluicio ingest speaks OTLP — use an 'otlphttp' exporter with an 'Authorization: Bearer <token>' header. The catalog's Sluicio preset configures this for you."
	}
	// Same type under a different kind is a common mistake.
	for _, k := range []registry.Kind{registry.KindReceiver, registry.KindProcessor, registry.KindExporter, registry.KindExtension, registry.KindConnector} {
		if k == kind {
			continue
		}
		if c := v.reg.Find(k, typeName); c != nil && c.AvailableIn(v.version) {
			return fmt.Sprintf("'%s' exists as a %s — is it in the wrong section?", typeName, k)
		}
	}
	// Otherwise suggest the closest known type of this kind.
	best, bestDist := "", 3
	for _, c := range v.reg.Components {
		if c.Kind != kind || !c.AvailableIn(v.version) {
			continue
		}
		if d := levenshtein(typeName, c.Type); d < bestDist {
			best, bestDist = c.Type, d
		}
	}
	if best != "" {
		return fmt.Sprintf("Did you mean '%s'?", best)
	}
	return "This designer validates against a curated registry — custom or vendor components are flagged but may still be valid in your build."
}

// --- service section ---

func (v *validator) checkService(node *yaml.Node) {
	node = resolve(node)
	if node == nil || node.Kind != yaml.MappingNode {
		v.add(SevError, "'service' must be a mapping.", "service", node, "")
		return
	}
	var pipelines *yaml.Node
	forEachEntry(node, func(key, val *yaml.Node) {
		switch key.Value {
		case "pipelines":
			pipelines = val
		case "extensions":
			v.checkServiceExtensions(val)
		case "telemetry":
			// free-form; accepted
		default:
			v.add(SevWarning, fmt.Sprintf("Unknown service field '%s'.", key.Value), "service."+key.Value, key,
				"Expected: pipelines, extensions, telemetry.")
		}
	})
	if pipelines == nil {
		v.add(SevError, "service has no 'pipelines' — the collector will not start.", "service", node,
			"Define at least one pipeline, e.g. service.pipelines.traces.")
		return
	}
	p := resolve(pipelines)
	if p == nil || p.Kind != yaml.MappingNode || len(p.Content) == 0 {
		v.add(SevError, "'service.pipelines' must contain at least one pipeline.", "service.pipelines", pipelines, "")
		return
	}
	forEachEntry(p, func(key, val *yaml.Node) {
		v.checkPipeline(key, val)
	})
}

func (v *validator) checkServiceExtensions(node *yaml.Node) {
	node = resolve(node)
	if node == nil || node.Tag == "!!null" {
		return
	}
	if node.Kind != yaml.SequenceNode {
		v.add(SevError, "'service.extensions' must be a list of extension IDs.", "service.extensions", node, "")
		return
	}
	for _, item := range node.Content {
		item = resolve(item)
		id := item.Value
		v.used[registry.KindExtension][id] = true
		if _, ok := v.defined[registry.KindExtension][id]; !ok {
			v.add(SevError, fmt.Sprintf("Extension '%s' is enabled but not defined in the 'extensions' section.", id),
				"service.extensions", item, "")
		}
	}
}

func (v *validator) checkPipeline(key, val *yaml.Node) {
	id := key.Value
	signal := componentType(id) // pipeline IDs share the type[/name] form
	path := "service.pipelines." + id
	if signal != "traces" && signal != "metrics" && signal != "logs" {
		v.add(SevError, fmt.Sprintf("Unknown pipeline type '%s'.", signal), path, key,
			"Pipelines must be named traces, metrics or logs, optionally with a /suffix (e.g. traces/backend).")
		return
	}
	val = resolve(val)
	if val == nil || val.Kind != yaml.MappingNode {
		v.add(SevError, fmt.Sprintf("Pipeline '%s' must be a mapping with receivers and exporters.", id), path, key, "")
		return
	}
	var haveReceivers, haveExporters bool
	forEachEntry(val, func(k, list *yaml.Node) {
		switch k.Value {
		case "receivers":
			haveReceivers = v.checkPipelineRefs(id, signal, "receivers", list, path)
		case "processors":
			v.checkPipelineRefs(id, signal, "processors", list, path)
		case "exporters":
			haveExporters = v.checkPipelineRefs(id, signal, "exporters", list, path)
		default:
			v.add(SevWarning, fmt.Sprintf("Unknown pipeline field '%s'.", k.Value), path+"."+k.Value, k,
				"Pipelines accept: receivers, processors, exporters.")
		}
	})
	if !haveReceivers {
		v.add(SevError, fmt.Sprintf("Pipeline '%s' has no receivers.", id), path, key,
			"A pipeline needs at least one receiver (or connector) feeding it.")
	}
	if !haveExporters {
		v.add(SevError, fmt.Sprintf("Pipeline '%s' has no exporters.", id), path, key,
			"A pipeline needs at least one exporter (or connector) consuming it.")
	}
}

// checkPipelineRefs validates one of the receivers/processors/exporters lists
// of a pipeline. Returns true if the list contains at least one entry.
func (v *validator) checkPipelineRefs(pipelineID, signal, role string, list *yaml.Node, basePath string) bool {
	list = resolve(list)
	path := basePath + "." + role
	if list == nil || list.Tag == "!!null" {
		return false
	}
	if list.Kind != yaml.SequenceNode {
		v.add(SevError, fmt.Sprintf("'%s' of pipeline '%s' must be a list.", role, pipelineID), path, list, "")
		return false
	}
	for _, item := range list.Content {
		item = resolve(item)
		id := item.Value
		typeName := componentType(id)

		switch role {
		case "processors":
			v.used[registry.KindProcessor][id] = true
			if _, ok := v.defined[registry.KindProcessor][id]; !ok {
				v.add(SevError, fmt.Sprintf("Processor '%s' is used in pipeline '%s' but not defined.", id, pipelineID), path, item, "")
				continue
			}
			v.checkSignalSupport(registry.KindProcessor, typeName, signal, pipelineID, item, path)
		case "receivers", "exporters":
			kind := registry.KindReceiver
			if role == "exporters" {
				kind = registry.KindExporter
			}
			if _, isConn := v.defined[registry.KindConnector][id]; isConn {
				v.used[registry.KindConnector][id] = true
				v.connNodes[id] = item
				if role == "exporters" {
					v.connAsExporter[id] = true
					v.checkConnectorSignal(id, typeName, signal, "from", pipelineID, item, path)
				} else {
					v.connAsReceiver[id] = true
					v.checkConnectorSignal(id, typeName, signal, "to", pipelineID, item, path)
				}
				continue
			}
			v.used[kind][id] = true
			if _, ok := v.defined[kind][id]; !ok {
				v.add(SevError, fmt.Sprintf("%s '%s' is used in pipeline '%s' but not defined.",
					capitalize(string(kind)), id, pipelineID), path, item,
					fmt.Sprintf("Add it under the top-level '%ss' section.", kind))
				continue
			}
			v.checkSignalSupport(kind, typeName, signal, pipelineID, item, path)
		}
	}
	return len(list.Content) > 0
}

func (v *validator) checkSignalSupport(kind registry.Kind, typeName, signal, pipelineID string, node *yaml.Node, path string) {
	comp := v.reg.Find(kind, typeName)
	if comp == nil || !comp.AvailableIn(v.version) {
		return // definition site already reported it
	}
	for _, s := range comp.Signals {
		if s == signal {
			return
		}
	}
	v.add(SevError,
		fmt.Sprintf("The %s '%s' does not support %s and cannot be used in pipeline '%s'.", kind, typeName, signal, pipelineID),
		path, node,
		fmt.Sprintf("'%s' supports: %s.", typeName, strings.Join(comp.Signals, ", ")))
}

func (v *validator) checkConnectorSignal(id, typeName, signal, dir, pipelineID string, node *yaml.Node, path string) {
	comp := v.reg.Find(registry.KindConnector, typeName)
	if comp == nil || !comp.AvailableIn(v.version) {
		return
	}
	for _, c := range comp.Connects {
		if (dir == "from" && c.From == signal) || (dir == "to" && c.To == signal) {
			return
		}
	}
	role, prep := "consume from", "as an exporter of"
	if dir == "to" {
		role, prep = "emit into", "as a receiver of"
	}
	pairs := make([]string, 0, len(comp.Connects))
	for _, c := range comp.Connects {
		pairs = append(pairs, c.From+" → "+c.To)
	}
	v.add(SevError,
		fmt.Sprintf("Connector '%s' cannot %s a %s pipeline (%s pipeline '%s').", id, role, signal, prep, pipelineID),
		path, node,
		fmt.Sprintf("'%s' supports: %s.", typeName, strings.Join(pairs, ", ")))
}

func (v *validator) checkUnused() {
	type kn struct {
		kind registry.Kind
		id   string
		node *yaml.Node
	}
	var unused []kn
	for kind, defs := range v.defined {
		if kind == registry.KindConnector {
			continue // connectors get their own role check
		}
		for id, node := range defs {
			if !v.used[kind][id] {
				unused = append(unused, kn{kind, id, node})
			}
		}
	}
	sort.Slice(unused, func(i, j int) bool { return unused[i].node.Line < unused[j].node.Line })
	for _, u := range unused {
		msg := fmt.Sprintf("%s '%s' is defined but not used in any pipeline.", capitalize(string(u.kind)), u.id)
		hint := "Add it to a pipeline in service.pipelines, or remove it."
		if u.kind == registry.KindExtension {
			msg = fmt.Sprintf("Extension '%s' is defined but not enabled.", u.id)
			hint = "Add it to service.extensions, or remove it."
		}
		v.add(SevWarning, msg, string(u.kind)+"s."+u.id, u.node, hint)
	}
}

func (v *validator) checkConnectorRoles() {
	for id, node := range v.defined[registry.KindConnector] {
		asExp, asRecv := v.connAsExporter[id], v.connAsReceiver[id]
		switch {
		case !asExp && !asRecv:
			v.add(SevWarning, fmt.Sprintf("Connector '%s' is defined but not used in any pipeline.", id),
				"connectors."+id, node,
				"A connector must be listed as an exporter in one pipeline and a receiver in another.")
		case asExp && !asRecv:
			v.add(SevError, fmt.Sprintf("Connector '%s' is used as an exporter but never as a receiver.", id),
				"connectors."+id, node,
				"Add it to the receivers list of the pipeline that should consume its output.")
		case asRecv && !asExp:
			v.add(SevError, fmt.Sprintf("Connector '%s' is used as a receiver but never as an exporter.", id),
				"connectors."+id, node,
				"Add it to the exporters list of the pipeline that should feed it.")
		}
	}
}

// --- schema checking ---

type schema struct {
	Type                 string             `json:"type"`
	Properties           map[string]*schema `json:"properties"`
	Items                *schema            `json:"items"`
	Values               *schema            `json:"values"`
	Enum                 []string           `json:"enum"`
	Required             []string           `json:"required"`
	AdditionalProperties bool               `json:"additionalProperties"`
}

var durationRe = regexp.MustCompile(`^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))*$`)

func (v *validator) checkAgainstSchema(raw json.RawMessage, node *yaml.Node, path string) {
	var s schema
	if err := json.Unmarshal(raw, &s); err != nil {
		return
	}
	v.checkSchemaNode(&s, node, path)
}

func (v *validator) checkSchemaNode(s *schema, node *yaml.Node, path string) {
	node = resolve(node)
	isNull := node == nil || node.Tag == "!!null"

	// Required fields apply even when the config block is empty.
	if s.Type == "object" && len(s.Required) > 0 {
		present := map[string]bool{}
		if !isNull && node.Kind == yaml.MappingNode {
			forEachEntry(node, func(k, _ *yaml.Node) { present[k.Value] = true })
		}
		for _, req := range s.Required {
			if !present[req] {
				target := node
				v.add(SevError, fmt.Sprintf("Missing required field '%s'.", req), path, target, "")
			}
		}
	}
	if isNull {
		return
	}

	// Values containing env-var/config expansion are opaque to us.
	if node.Kind == yaml.ScalarNode && strings.Contains(node.Value, "${") {
		return
	}

	switch s.Type {
	case "object":
		if node.Kind != yaml.MappingNode {
			v.add(SevError, fmt.Sprintf("'%s' must be a mapping.", lastSegment(path)), path, node, "")
			return
		}
		forEachEntry(node, func(k, val *yaml.Node) {
			sub, known := s.Properties[k.Value]
			if !known {
				if !s.AdditionalProperties && len(s.Properties) > 0 {
					v.add(SevWarning, fmt.Sprintf("Unrecognized field '%s'.", k.Value), path+"."+k.Value, k,
						knownFieldsHint(s))
				}
				return
			}
			v.checkSchemaNode(sub, val, path+"."+k.Value)
		})
	case "map":
		if node.Kind != yaml.MappingNode {
			v.add(SevError, fmt.Sprintf("'%s' must be a mapping.", lastSegment(path)), path, node, "")
			return
		}
		if s.Values != nil {
			forEachEntry(node, func(k, val *yaml.Node) {
				v.checkSchemaNode(s.Values, val, path+"."+k.Value)
			})
		}
	case "array":
		if node.Kind != yaml.SequenceNode {
			v.add(SevError, fmt.Sprintf("'%s' must be a list.", lastSegment(path)), path, node, "")
			return
		}
		if s.Items != nil {
			for i, item := range node.Content {
				v.checkSchemaNode(s.Items, item, fmt.Sprintf("%s[%d]", path, i))
			}
		}
	case "string":
		if node.Kind != yaml.ScalarNode {
			v.add(SevError, fmt.Sprintf("'%s' must be a string.", lastSegment(path)), path, node, "")
			return
		}
		if len(s.Enum) > 0 && !contains(s.Enum, node.Value) {
			v.add(SevError, fmt.Sprintf("'%s' must be one of: %s.", lastSegment(path), strings.Join(s.Enum, ", ")), path, node, "")
		}
	case "int", "number":
		if node.Kind != yaml.ScalarNode || (node.Tag != "!!int" && node.Tag != "!!float") {
			v.add(SevError, fmt.Sprintf("'%s' must be a number.", lastSegment(path)), path, node, "")
		} else if s.Type == "int" && node.Tag == "!!float" {
			v.add(SevError, fmt.Sprintf("'%s' must be an integer.", lastSegment(path)), path, node, "")
		}
	case "bool":
		if node.Kind != yaml.ScalarNode || node.Tag != "!!bool" {
			v.add(SevError, fmt.Sprintf("'%s' must be true or false.", lastSegment(path)), path, node, "")
		}
	case "duration":
		ok := node.Kind == yaml.ScalarNode &&
			(node.Tag == "!!int" || durationRe.MatchString(strings.TrimSpace(node.Value)))
		if !ok {
			v.add(SevError, fmt.Sprintf("'%s' must be a duration like 200ms, 10s or 1m.", lastSegment(path)), path, node, "")
		}
	}
}

func knownFieldsHint(s *schema) string {
	if len(s.Properties) == 0 {
		return ""
	}
	keys := make([]string, 0, len(s.Properties))
	for k := range s.Properties {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) > 8 {
		keys = append(keys[:8], "…")
	}
	return "Known fields: " + strings.Join(keys, ", ") + "."
}

// --- helpers ---

func (v *validator) result() Result {
	valid := true
	for _, d := range v.diags {
		if d.Severity == SevError {
			valid = false
			break
		}
	}
	if v.diags == nil {
		v.diags = []Diagnostic{}
	}
	sort.SliceStable(v.diags, func(i, j int) bool { return v.diags[i].Line < v.diags[j].Line })
	return Result{Valid: valid, Diagnostics: v.diags}
}

func (v *validator) add(sev Severity, msg, path string, node *yaml.Node, hint string) {
	d := Diagnostic{Severity: sev, Message: msg, Path: path, Hint: hint}
	if node != nil {
		d.Line, d.Column = node.Line, node.Column
	}
	v.diags = append(v.diags, d)
}

var yamlErrLineRe = regexp.MustCompile(`(?:yaml: )?line (\d+):`)

func (v *validator) addYAMLError(err error) {
	msg := err.Error()
	line := 0
	if m := yamlErrLineRe.FindStringSubmatch(msg); m != nil {
		fmt.Sscanf(m[1], "%d", &line)
	}
	msg = strings.TrimPrefix(msg, "yaml: ")
	v.diags = append(v.diags, Diagnostic{
		Severity: SevError,
		Message:  "YAML syntax error: " + msg,
		Line:     line,
	})
}

func unwrapDoc(n *yaml.Node) *yaml.Node {
	if n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
		return resolve(n.Content[0])
	}
	return resolve(n)
}

func resolve(n *yaml.Node) *yaml.Node {
	for n != nil && n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	return n
}

func forEachEntry(mapping *yaml.Node, fn func(key, val *yaml.Node)) {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		fn(resolve(mapping.Content[i]), mapping.Content[i+1])
	}
}

// componentType returns the type part of a 'type/name' component ID.
func componentType(id string) string {
	if i := strings.IndexByte(id, '/'); i >= 0 {
		return id[:i]
	}
	return id
}

func lastSegment(path string) string {
	if i := strings.LastIndexByte(path, '.'); i >= 0 {
		return path[i+1:]
	}
	return path
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func levenshtein(a, b string) int {
	la, lb := len(a), len(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[lb]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}
