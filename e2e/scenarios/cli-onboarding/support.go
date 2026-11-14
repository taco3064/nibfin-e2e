package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

// These drivers compile beside the acquired CLI's maintained test transports.
// Their recipes/archives are synthetic. They do not certify producer compatibility.
type e2eCall struct {
	Method string
	Path   string
	Input  any
}

type e2eAPI struct {
	API
	calls   []e2eCall
	deny    string
	invalid string
	lost    string
	hide    string
	wrote   bool
}

func (f *e2eAPI) Call(method, path string, input, output any) error {
	f.calls = append(f.calls, e2eCall{method, path, input})
	if method == "GET" && f.wrote && path == f.hide {
		return errors.New("READ_BACK_UNAVAILABLE")
	}
	if method != "GET" {
		f.wrote = true
		if path == f.deny {
			return errors.New("PERMISSION_DENIED")
		}
	}
	err := f.API.Call(method, path, input, output)
	if path == f.invalid && output != nil {
		return assign(output, map[string]any{"sha": "invalid", "number": -1})
	}
	if method != "GET" && path == f.lost {
		return errors.New("LOST_RESPONSE")
	}
	return err
}

type e2eNoProcess struct{ t *testing.T }

func (p e2eNoProcess) Run(string, []string, []byte) ([]byte, error) {
	p.t.Fatal("no local installer, Runner, service or downloaded code may execute")
	return nil, nil
}

func e2eRun(t *testing.T, api API, command string, apply bool) (
	[]json.RawMessage, error,
) {
	t.Helper()
	args := []string{command, "--repo", "example/project"}
	if apply {
		args = append(args, "--apply")
	}
	var output bytes.Buffer
	err := (App{API: api, Process: e2eNoProcess{t}}).Run(args, &output)
	decoder := json.NewDecoder(&output)
	documents := []json.RawMessage{}
	for {
		var value json.RawMessage
		decodeErr := decoder.Decode(&value)
		if decodeErr == io.EOF {
			break
		}
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		documents = append(documents, value)
	}
	return documents, err
}

func e2ePreview(t *testing.T, f API) InitPlan {
	t.Helper()
	documents, err := e2eRun(t, f, "init", false)
	if err != nil || len(documents) != 1 {
		t.Fatal(documents, err)
	}
	var preview struct {
		Status    string   `json:"status"`
		Plan      InitPlan `json:"plan"`
		Protected string   `json:"protected_execution"`
	}
	if json.Unmarshal(documents[0], &preview) != nil || preview.Status != "preview" ||
		preview.Protected != "unverified" {
		t.Fatal(string(documents[0]))
	}
	return preview.Plan
}

func e2eSafeWrites(t *testing.T, calls []e2eCall) int {
	t.Helper()
	count := 0
	for _, call := range calls {
		if call.Method == "GET" {
			continue
		}
		count++
		allowed := false
		for _, suffix := range []string{
			"/git/trees", "/git/commits", "/git/refs", "/pulls", "/labels",
		} {
			if call.Path == e2eRepo+suffix {
				allowed = true
			}
		}
		if call.Method != "POST" || !allowed {
			t.Fatal("unexpected mutation", call)
		}
		if call.Path == e2eRepo+"/git/refs" {
			ref := call.Input.(map[string]string)["ref"]
			if !strings.HasPrefix(ref, "refs/heads/nibfin/") {
				t.Fatal("proposal may only create a Nibfin branch", ref)
			}
		}
	}
	return count
}

func e2eEqual(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("%+v != %+v", actual, expected)
	}
}

func e2eOwners(t *testing.T, check func(*testing.T, string)) {
	t.Helper()
	for _, owner := range []string{"User", "Organization"} {
		t.Run(owner, func(t *testing.T) { check(t, owner) })
	}
}
