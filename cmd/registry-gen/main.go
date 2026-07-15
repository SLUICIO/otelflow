// registry-gen derives the component catalog from the OpenTelemetry
// Collector repositories themselves: which components exist at which
// version (presence of <kind>/<dir>/go.mod in the git tree at each tag),
// which signals and stability they declare (their metadata.yaml), and which
// distribution they belong to (presence in the core vs contrib repo).
//
// Usage (needs a GitHub token to stay under rate limits):
//
//	GITHUB_TOKEN=$(gh auth token) go run ./cmd/registry-gen \
//	  -out internal/registry/data/generated.json
//
// The output is merged at load time with the hand-curated overlay
// (components.json), which contributes config schemas, descriptions and
// deprecation guidance for the popular components.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

var versions = []string{
	"0.70.0", "0.77.0", "0.80.0", "0.86.0", "0.90.1", "0.96.0",
	"0.102.1", "0.109.0", "0.115.1", "0.120.0", "0.127.0",
}

var repos = map[string]string{
	"core":    "open-telemetry/opentelemetry-collector",
	"contrib": "open-telemetry/opentelemetry-collector-contrib",
}

var componentDirRe = regexp.MustCompile(`^(receiver|processor|exporter|extension|connector)/([^/]+)/go\.mod$`)

type metadataFile struct {
	Type   string `yaml:"type"`
	Status struct {
		Class     string              `yaml:"class"`
		Stability map[string][]string `yaml:"stability"`
	} `yaml:"status"`
}

type connection struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type genComponent struct {
	Type          string       `json:"type"`
	Kind          string       `json:"kind"`
	Signals       []string     `json:"signals,omitempty"`
	Connects      []connection `json:"connects,omitempty"`
	Added         string       `json:"added"`
	Removed       string       `json:"removed,omitempty"`
	Stability     string       `json:"stability"`
	Distributions []string     `json:"distributions"`
	DocsURL       string       `json:"docsUrl"`
}

type output struct {
	GeneratedAt string         `json:"generatedAt"`
	Source      string         `json:"source"`
	Versions    []string       `json:"versions"`
	Components  []genComponent `json:"components"`
}

const sourceNote = "Derived from the Apache-2.0 licensed repositories " +
	"open-telemetry/opentelemetry-collector and open-telemetry/opentelemetry-collector-contrib."

var httpClient = &http.Client{Timeout: 60 * time.Second}

func main() {
	out := flag.String("out", "internal/registry/data/generated.json", "output file")
	flag.Parse()
	if os.Getenv("GITHUB_TOKEN") == "" {
		log.Println("warning: GITHUB_TOKEN not set — likely to hit rate limits")
	}

	// presence[repo][dirKey] = set of versions where the component exists
	presence := map[string]map[string]map[string]bool{}
	for repoKey, repo := range repos {
		presence[repoKey] = map[string]map[string]bool{}
		for _, v := range versions {
			dirs, err := listComponentDirsAnyTag(repo, v)
			if err != nil {
				log.Fatalf("listing %s@v%s: %v", repo, v, err)
			}
			log.Printf("%s v%s: %d component dirs", repoKey, v, len(dirs))
			for _, d := range dirs {
				if presence[repoKey][d] == nil {
					presence[repoKey][d] = map[string]bool{}
				}
				presence[repoKey][d][v] = true
			}
		}
	}

	// Union of all directories; contrib wins for metadata (superset).
	type source struct{ repoKey, repo, dir string }
	sources := map[string]source{} // dirKey -> where to read metadata from
	for repoKey, repo := range repos {
		for dir := range presence[repoKey] {
			if s, ok := sources[dir]; !ok || s.repoKey == "core" {
				sources[dir] = source{repoKey, repo, dir}
			}
		}
	}

	var comps []genComponent
	for dirKey, src := range sources {
		kind := strings.SplitN(dirKey, "/", 2)[0]
		inCore := presence["core"][dirKey] != nil
		inContrib := presence["contrib"][dirKey] != nil

		// Union presence across repos per version.
		present := map[string]bool{}
		for _, repoKey := range []string{"core", "contrib"} {
			for v := range presence[repoKey][dirKey] {
				present[v] = true
			}
		}
		added, removed, lastPresent := availability(present)

		meta, err := fetchMetadataAnyTag(src.repo, lastPresent, dirKey)
		if err != nil {
			log.Printf("skip %s: no readable metadata at v%s (%v)", dirKey, lastPresent, err)
			continue
		}
		if meta.Type == "" || meta.Status.Class != kind {
			// Not a real pipeline component (shared library modules etc.).
			continue
		}

		signals, connects, stability := interpretStability(kind, meta.Status.Stability)
		dists := []string{}
		if inCore {
			dists = append(dists, "core")
		}
		if inContrib {
			dists = append(dists, "contrib")
		}
		comps = append(comps, genComponent{
			Type: meta.Type, Kind: kind,
			Signals: signals, Connects: connects,
			Added: added, Removed: removed,
			Stability: stability, Distributions: dists,
			DocsURL: fmt.Sprintf("https://github.com/%s/tree/main/%s", src.repo, dirKey),
		})
	}

	sort.Slice(comps, func(i, j int) bool {
		if comps[i].Kind != comps[j].Kind {
			return comps[i].Kind < comps[j].Kind
		}
		return comps[i].Type < comps[j].Type
	})

	data, _ := json.MarshalIndent(output{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Source:      sourceNote,
		Versions:    versions,
		Components:  comps,
	}, "", " ")
	if err := os.WriteFile(*out, append(data, '\n'), 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %d components to %s", len(comps), *out)
}

// availability derives added/removed from the presence set, relative to the
// supported version list. removed is the first supported version where the
// component no longer exists after having existed.
func availability(present map[string]bool) (added, removed, lastPresent string) {
	for _, v := range versions {
		if present[v] {
			if added == "" {
				added = v
			}
			lastPresent = v
			removed = ""
		} else if added != "" && removed == "" {
			removed = v
		}
	}
	return
}

var connectorPairRe = regexp.MustCompile(`^([a-z]+)_to_([a-z]+)$`)

// interpretStability maps a metadata.yaml stability block to signals (or
// connector routes) and a single overall stability label.
func interpretStability(kind string, stability map[string][]string) ([]string, []connection, string) {
	rank := map[string]int{"stable": 6, "beta": 5, "alpha": 4, "development": 3, "unmaintained": 2, "deprecated": 1}
	best := ""
	signalSet := map[string]bool{}
	var connects []connection
	for level, targets := range stability {
		if rank[level] > rank[best] {
			best = level
		}
		for _, t := range targets {
			if kind == "connector" {
				if m := connectorPairRe.FindStringSubmatch(t); m != nil {
					connects = append(connects, connection{From: m[1], To: m[2]})
				}
				continue
			}
			switch t {
			case "traces", "metrics", "logs":
				signalSet[t] = true
			}
		}
	}
	if best == "" {
		best = "development"
	}
	var signals []string
	for _, s := range []string{"traces", "metrics", "logs"} {
		if signalSet[s] {
			signals = append(signals, s)
		}
	}
	sort.Slice(connects, func(i, j int) bool {
		return connects[i].From+connects[i].To < connects[j].From+connects[j].To
	})
	return signals, connects, best
}

// tagCandidates returns the tags to try for a version: core and contrib cut
// patch releases independently, so v0.115.1 may only exist as v0.115.0 in
// the other repository.
func tagCandidates(version string) []string {
	tags := []string{"v" + version}
	parts := strings.Split(version, ".")
	if len(parts) == 3 && parts[2] != "0" {
		tags = append(tags, "v"+parts[0]+"."+parts[1]+".0")
	}
	return tags
}

func listComponentDirsAnyTag(repo, version string) (dirs []string, err error) {
	for _, tag := range tagCandidates(version) {
		dirs, err = listComponentDirs(repo, tag)
		if err == nil {
			return dirs, nil
		}
	}
	return nil, err
}

func fetchMetadataAnyTag(repo, version, dirKey string) (meta *metadataFile, err error) {
	for _, tag := range tagCandidates(version) {
		meta, err = fetchMetadata(repo, tag, dirKey)
		if err == nil {
			return meta, nil
		}
	}
	return nil, err
}

func listComponentDirs(repo, tag string) ([]string, error) {
	var tree struct {
		Truncated bool `json:"truncated"`
		Tree      []struct {
			Path string `json:"path"`
		} `json:"tree"`
	}
	url := fmt.Sprintf("https://api.github.com/repos/%s/git/trees/%s?recursive=1", repo, tag)
	if err := getJSON(url, &tree); err != nil {
		return nil, err
	}
	if tree.Truncated {
		return nil, fmt.Errorf("git tree truncated for %s@%s", repo, tag)
	}
	var dirs []string
	for _, e := range tree.Tree {
		if m := componentDirRe.FindStringSubmatch(e.Path); m != nil {
			dirs = append(dirs, m[1]+"/"+m[2])
		}
	}
	return dirs, nil
}

func fetchMetadata(repo, tag, dirKey string) (*metadataFile, error) {
	url := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/metadata.yaml", repo, tag, dirKey)
	resp, err := httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var meta metadataFile
	if err := yaml.Unmarshal(body, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func getJSON(url string, v any) error {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if tok := os.Getenv("GITHUB_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}
