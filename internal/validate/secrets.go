package validate

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// A credential written into the configuration, rather than taken from an
// environment variable, sits in the file and in every copy of it: the
// repository, the image, the backup, the paste in a ticket. The collector
// resolves ${env:NAME} at startup, so the value never has to be in the
// file. This check warns where one is written out.
//
// What counts is decided by the value's own key: one that names a secret
// (password, token, api_key, authorization, client_secret, ...) but not
// something about it (token_url, client_secret_file), a header given as a
// name/value pair whose name does, "key" under a TLS block, a PEM private
// key under any key, and credentials in a URL (user:password@ or a
// secret-named query parameter). Numbers and booleans never count. A value that refers to a variable, even
// inside other text ("Bearer ${env:TOKEN}"), is fine. So are placeholders
// a tool put there in place of a value: [REDACTED], which a collector
// reports for opaque fields, and a run of asterisks.

// secretKeyParts match a key after lowercasing and dropping '_', '-' and
// '.', so client_secret, x-api-key and sasToken all count.
var secretKeyParts = []string{
	"password", "passwd", "secret", "token", "apikey", "authorization",
	"credential", "privatekey", "bearer", "cookie", "accesskey",
	"connectionstring", "signature", "passphrase",
	"instrumentationkey", "sharedkey", "accountkey", "signingkey", "encryptionkey", "masterkey", "licensekey", "subscriptionkey",
}

// secretKeysExact are too short to match as parts (keyfile, dsnresolver).
var secretKeysExact = map[string]bool{"pwd": true, "dsn": true, "pass": true, "keypem": true}

// notSecretKeys hold a reference, never the secret: auth.authenticator
// names an extension.
var notSecretKeys = map[string]bool{"authenticator": true}

// notSecretSuffixes end keys that name something about a secret rather
// than the secret: token_url, client_secret_file, token_expiry.
var notSecretSuffixes = []string{"url", "uri", "endpoint", "file", "path", "expiry", "timeout", "interval", "buffer", "duration", "ttl"}

var placeholderRe = regexp.MustCompile(`^(\[REDACTED\]|\*+)$`)

func secretKey(k string) bool {
	if notSecretKeys[strings.ToLower(k)] {
		return false
	}
	n := strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(k))
	for _, s := range notSecretSuffixes {
		if strings.HasSuffix(n, s) {
			return false
		}
	}
	if secretKeysExact[n] {
		return true
	}
	for _, p := range secretKeyParts {
		if strings.Contains(n, p) {
			return true
		}
	}
	return false
}

func tlsKey(k string) bool {
	n := strings.ToLower(k)
	return strings.HasPrefix(n, "tls") || strings.HasPrefix(n, "ssl")
}

// checkPlainSecrets walks the components' settings and service.telemetry.
// A component's ID is a name, not a value: otlphttp/secrets is no secret,
// and reading it as one would flag the whole component.
func (v *validator) checkPlainSecrets(root *yaml.Node) {
	forEachEntry(root, func(key, val *yaml.Node) {
		val = resolve(val)
		switch {
		case sectionKinds[key.Value] != "" && val.Kind == yaml.MappingNode:
			forEachEntry(val, func(id, settings *yaml.Node) {
				v.walkSecrets(resolve(settings), key.Value+"."+id.Value, false, false)
			})
		case key.Value == "service" && val.Kind == yaml.MappingNode:
			forEachEntry(val, func(k, sv *yaml.Node) {
				if k.Value == "telemetry" {
					v.walkSecrets(resolve(sv), "service.telemetry", false, false)
				}
			})
		}
	})
}

func (v *validator) walkSecrets(n *yaml.Node, path string, underSecret, inTLS bool) {
	if n == nil {
		return
	}
	switch n.Kind {
	case yaml.SequenceNode:
		for i, c := range n.Content {
			v.walkSecrets(resolve(c), fmt.Sprintf("%s[%d]", path, i), underSecret, false)
		}
	case yaml.MappingNode:
		// A pair spelled {name: authorization, value: ...}.
		named := false
		forEachEntry(n, func(k, val *yaml.Node) {
			val = resolve(val)
			if (k.Value == "name" || k.Value == "key") && val.Kind == yaml.ScalarNode && secretKey(val.Value) {
				named = true
			}
		})
		// A key's secrecy covers its value, or a list of values, never a
		// whole map below it: under client_auth the username is no secret,
		// the password is, by its own key.
		forEachEntry(n, func(k, val *yaml.Node) {
			secret := secretKey(k.Value) || (named && k.Value == "value") || (inTLS && k.Value == "key")
			v.walkSecrets(resolve(val), path+"."+k.Value, secret, tlsKey(k.Value))
		})
	case yaml.ScalarNode:
		s := strings.TrimSpace(n.Value)
		if s == "" || strings.Contains(s, "${") || placeholderRe.MatchString(s) || n.Tag == "!!bool" || n.Tag == "!!null" || n.Tag == "!!int" || n.Tag == "!!float" {
			return
		}
		switch {
		case underSecret, strings.Contains(s, "-----BEGIN") && strings.Contains(s, "PRIVATE KEY"):
			v.add(SevWarning, fmt.Sprintf("A secret is written in plain text at %s.", path), path, n, envHint)
		case strings.Contains(s, "://"):
			if what := urlCredential(s); what != "" {
				v.add(SevWarning, fmt.Sprintf("The URL at %s has %s written in plain text.", path, what), path, n, envHint)
			}
		}
	}
}

const envHint = "Anyone with the file can read it. Set it as an environment variable and refer to it as ${env:NAME}; the collector resolves it at startup."

// urlCredential says what credential a URL carries in plain text: a
// password in its user info, or a secret-named query parameter.
func urlCredential(s string) string {
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	if u.User != nil {
		if p, ok := u.User.Password(); ok && !placeholderRe.MatchString(p) {
			return "a password"
		}
	}
	for k, vals := range u.Query() {
		if secretKey(k) || k == "sig" || k == "code" {
			for _, val := range vals {
				if val != "" && !placeholderRe.MatchString(val) {
					return "a credential (" + k + ")"
				}
			}
		}
	}
	return ""
}
