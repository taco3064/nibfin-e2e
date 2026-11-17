package cli

import (
	"errors"
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

func (p e2eNoProcess) Run(file string, args []string, input []byte) ([]byte, error) {
	if e2eDiagnosticProbe(file, args, input) {
		return nil, errors.New("FIXTURE_HOST_PROBE_UNAVAILABLE")
	}
	p.t.Fatal("no local installer, Runner, service or downloaded code may execute")
	return nil, nil
}

func e2ePreview(t *testing.T, api API) InitPlan {
	t.Helper()
	plan, err := planInitRecipe(api, "example/project", "example/project", "issue")
	if err != nil {
		t.Fatal(err)
	}
	return plan
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

// Public init preview may request read-only diagnostics. Refuse them with an
// unavailable observation; never invoke systemctl, Docker or an installed host.
func e2eDiagnosticProbe(file string, args []string, input []byte) bool {
	if file != "/usr/bin/env" || input != nil {
		return false
	}
	for _, service := range []string{"docker.service", "nibfin-engine.service"} {
		want := []string{"-i", "PATH=/usr/bin:/bin", "LANG=C",
			"/usr/bin/systemctl", "show", service,
			"--property=LoadState,ActiveState", "--no-pager"}
		if reflect.DeepEqual(args, want) {
			return true
		}
	}
	for _, socket := range []string{"/run/docker.sock", "/run/nibfin-engine/docker.sock"} {
		want := []string{"-i", "PATH=/usr/bin:/bin", "LANG=C", "/usr/bin/docker",
			"--config", "/etc/nibfin/engine/client", "--host", "unix://" + socket,
			"info", "--format", "{{json .}}"}
		if reflect.DeepEqual(args, want) {
			return true
		}
	}
	return false
}
