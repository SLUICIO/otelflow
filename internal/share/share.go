// Package share encodes configurations into the URL-fragment share format
// used by the web app (web/src/lib/share.ts): `1.` + base64url(deflate-raw
// (JSON {v, c})). Fragments never reach a server, so a link generated here
// carries the whole configuration and stores nothing anywhere.
package share

import (
	"bytes"
	"compress/flate"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// Encode returns the fragment payload (the part after `#share=`).
func Encode(config, version string) (string, error) {
	payload, err := json.Marshal(map[string]string{"v": version, "c": config})
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	w, err := flate.NewWriter(&buf, flate.BestCompression)
	if err != nil {
		return "", err
	}
	if _, err := w.Write(payload); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	return "1." + base64.RawURLEncoding.EncodeToString(buf.Bytes()), nil
}

// URL returns a complete share link for the given instance base URL.
func URL(base, config, version string) (string, error) {
	frag, err := Encode(config, version)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s/#share=%s", strings.TrimRight(base, "/"), frag), nil
}
