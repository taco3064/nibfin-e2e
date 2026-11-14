package cli

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const e2eRepo = "repos/example/project"

func TestE2EInitPreview(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		f := installFixture(t, owner)
		api := &e2eAPI{API: f}
		root := t.TempDir()
		t.Setenv("XDG_CACHE_HOME", root)
		plan := e2ePreview(t, api)
		e2eEqual(t, plan.Repository.Owner.Type, owner)
		e2eEqual(t, plan.Repository.Permissions, map[string]bool{"push": true})
		e2eEqual(t, plan.Labels, []string{"scope", "shaped", "delivered"})
		paths := []string{}
		for _, file := range plan.Files {
			paths = append(paths, file.Path)
			if strings.Contains(file.Content, "secrets: inherit") ||
				strings.Contains(file.Content, "pull_request_target") {
				t.Fatal(file.Path)
			}
		}
		e2eEqual(t, paths, []string{
			".github/workflows/nibfin-issue.yml", ".github/workflows/nibfin-stage.yml",
			".github/workflows/nibfin-wake.yml", ".nibfin/producer-pins.json",
		})
		entries, err := os.ReadDir(root)
		if err != nil || len(entries) != 0 {
			t.Fatal("preview cache side effect", err)
		}
		e2eEqual(t, e2eSafeWrites(t, api.calls), 0)
	})
}

// Init App.Run verifies the pinned Core cache before applying. The installation
// seam below is the exact maintained applyInit called by App.Run, supplied the
// plan decoded from actual App.Run output. No Core verifier is mocked as passed.
func TestE2EInitApply(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		for _, lost := range []bool{false, true} {
			f := installFixture(t, owner)
			f.lostRef, f.lostPR, f.lostLabel = lost, lost, lost
			api := &e2eAPI{API: f}
			plan := e2ePreview(t, api)
			result, err := applyInit(api, plan)
			if err != nil {
				t.Fatal(err)
			}
			e2eEqual(t, result.Status, "pending")
			e2eEqual(t, result.Code, "INSTALLATION_PR_REQUIRES_REVIEW_AND_MERGE")
			var observed installPR
			if api.Call("GET", e2eRepo+"/pulls/8", nil, &observed) != nil {
				t.Fatal("missing PR")
			}
			e2eEqual(t, result.PR, observed.URL)
			e2eEqual(t, observed.Base.Ref, plan.Repository.DefaultBranch)
			e2eEqual(t, observed.Head.Ref, "nibfin/init-"+plan.Head[:12])
			e2eEqual(t, observed.State, "open")
			// Independently compare submitted tree payload with the read-back contents.
			entries := []map[string]string{}
			for _, call := range api.calls {
				if call.Method == "POST" && call.Path == e2eRepo+"/git/refs" {
					body := call.Input.(map[string]string)
					e2eEqual(t, body["ref"], "refs/heads/"+observed.Head.Ref)
					e2eEqual(t, body["sha"], observed.Head.SHA)
				}
				if call.Method == "POST" && call.Path == e2eRepo+"/pulls" {
					body := call.Input.(map[string]any)
					e2eEqual(t, body["base"], observed.Base.Ref)
					e2eEqual(t, body["head"], observed.Head.Ref)
				}
				if call.Method == "POST" && call.Path == e2eRepo+"/git/trees" {
					body := call.Input.(map[string]any)
					entries = body["tree"].([]map[string]string)
					e2eEqual(t, body["base_tree"], strings.Repeat("d", 40))
				}
			}
			e2eEqual(t, len(entries), len(plan.Files))
			for i, entry := range entries {
				e2eEqual(t, entry["path"], plan.Files[i].Path)
				e2eEqual(t, entry["mode"], "100644")
				e2eEqual(t, entry["type"], "blob")
				data, _, err := content(api, "example/project", entry["path"], observed.Head.SHA)
				if err != nil {
					t.Fatal(err)
				}
				e2eEqual(t, string(data), entry["content"])
				e2eEqual(t, string(data), plan.Files[i].Content)
			}
			for _, label := range plan.Labels {
				var value struct {
					Name string `json:"name"`
				}
				if api.Call("GET", e2eRepo+"/labels/"+label, nil, &value) != nil {
					t.Fatal("missing label", label)
				}
				e2eEqual(t, value.Name, label)
			}
			e2eEqual(t, f.refPosts, 1)
			writes := e2eSafeWrites(t, api.calls)
			_, err = applyInit(api, plan)
			if err == nil || !strings.Contains(err.Error(), "INSTALL_BRANCH_EXISTS") {
				t.Fatal("existing installation branch must require inspection", err)
			}
			e2eEqual(t, e2eSafeWrites(t, api.calls), writes)
			// A simulated external merge is fixture setup, never a CLI write to main.
			ref := reference{Ref: "refs/heads/main"}
			ref.Object.SHA = observed.Head.SHA
			f.data[e2eRepo+"/git/ref/heads/main"] = ref
			unchanged := e2ePreview(t, api)
			e2eEqual(t, len(unchanged.Files), 0)
			e2eEqual(t, len(unchanged.Labels), 0)
			result, err = applyInit(api, unchanged)
			if err != nil || result.Status != "completed" {
				t.Fatal(result, err)
			}
			e2eEqual(t, e2eSafeWrites(t, api.calls), writes)
		}
	})
}

func TestE2EInitDenials(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		for _, kind := range []string{"permission", "revoked", "workflow-denied",
			"file-conflict", "branch-conflict", "invalid-response", "wrong-readback"} {
			t.Run(kind, func(t *testing.T) {
				f := installFixture(t, owner)
				api := &e2eAPI{API: f}
				plan := e2ePreview(t, api)
				switch kind {
				case "permission", "revoked":
					repo := f.data[e2eRepo].(Repository)
					repo.Permissions["push"] = false
					f.data[e2eRepo] = repo
				case "workflow-denied":
					api.deny = e2eRepo + "/git/trees"
				case "file-conflict":
					f.data[e2eRepo+"/contents/"+plan.Files[0].Path+"?ref="+plan.Head] =
						encoded([]byte("operator-owned replacement"))
				case "branch-conflict":
					f.data[e2eRepo+"/git/ref/heads/"+
						url.PathEscape("nibfin/init-"+plan.Head[:12])] = reference{}
				case "invalid-response":
					api.invalid = e2eRepo + "/git/trees"
				case "wrong-readback":
					f.wrongFile = true
				}
				if kind == "permission" {
					_, err := e2eRun(t, api, "init", true)
					if err == nil {
						t.Fatal("permission denial accepted")
					}
				} else {
					result, err := applyInit(api, plan)
					if err == nil || result.Status == "completed" || result.PR != "" {
						t.Fatal("denial cannot establish installation", result, err)
					}
				}
				if kind == "permission" || kind == "revoked" || kind == "file-conflict" ||
					kind == "branch-conflict" {
					e2eEqual(t, e2eSafeWrites(t, api.calls), 0)
				}
				e2eSafeWrites(t, api.calls)
			})
		}
	})
}

func TestE2EInitUnknown(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		for _, effect := range []string{"ref", "pull", "label"} {
			t.Run(effect, func(t *testing.T) {
				f := installFixture(t, owner)
				api := &e2eAPI{API: f}
				plan := e2ePreview(t, api)
				switch effect {
				case "ref":
					api.lost = e2eRepo + "/git/refs"
					api.hide = e2eRepo + "/git/ref/heads/" +
						url.PathEscape("nibfin/init-"+plan.Head[:12])
				case "pull":
					api.lost, api.hide = e2eRepo+"/pulls", e2eRepo+"/pulls/8"
				case "label":
					api.lost, api.hide = e2eRepo+"/labels", e2eRepo+"/labels/scope"
				}
				result, err := applyInit(api, plan)
				if err == nil || result.Status != "pending" {
					t.Fatal(result, err)
				}
				attempts := 0
				for _, call := range api.calls {
					if call.Method == "POST" && call.Path == api.lost {
						attempts++
					}
				}
				e2eEqual(t, attempts, 1)
				e2eSafeWrites(t, api.calls)
			})
		}
	})
}

func TestE2EInitSourceBoundary(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		f := installFixture(t, owner)
		api := &e2eAPI{API: f}
		t.Setenv("XDG_CACHE_HOME", t.TempDir())
		// No genuine pinned artifact is supplied. The real command must reject it,
		// rather than accept a synthetic archive as a producer verification success.
		var output bytes.Buffer
		err := (App{API: api, Process: e2eCachePath{t}}).Run(
			[]string{"init", "--repo", "example/project", "--apply"}, &output)
		if err == nil || err.Error() != "NOT_FOUND" {
			t.Fatal("missing genuine source artifact must reject", err)
		}
		e2eEqual(t, e2eSafeWrites(t, api.calls), 0)
	})
}

// Controlled observation of the harmless canonical-path Process read. This is
// not a verifier success, and no installer or downloaded code may execute.
type e2eCachePath struct{ t *testing.T }

func (p e2eCachePath) Run(file string, args []string, input []byte) ([]byte, error) {
	if file != "node" || len(args) != 4 || args[0] != "--input-type=module" ||
		args[1] != "-e" || input != nil {
		p.t.Fatal("unexpected process invocation", file, args)
	}
	path, err := filepath.EvalSymlinks(args[3])
	if err != nil {
		return nil, err
	}
	return json.Marshal(path)
}
