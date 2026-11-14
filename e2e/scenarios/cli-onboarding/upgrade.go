package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
)

func e2eUpgrade(t *testing.T, owner string) *upgradeAPI {
	t.Helper()
	f := upgradeFixture(t, false, true)
	repo := f.data[e2eRepo].(Repository)
	repo.Owner.Type = owner
	repo.Permissions = map[string]bool{"push": true}
	f.data[e2eRepo] = repo
	// Empty query observation is explicit; absent data must not imply no PR.
	f.data[pullListPath(upgradeBranchName)] = []upgradePull{}
	return f
}

func e2eUpgradeResult(t *testing.T, documents []json.RawMessage) InitResult {
	t.Helper()
	if len(documents) != 2 {
		t.Fatal("preview plus result required", documents)
	}
	var result InitResult
	if json.Unmarshal(documents[1], &result) != nil {
		t.Fatal(string(documents[1]))
	}
	return result
}

func TestE2EUpgradePreview(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		f := e2eUpgrade(t, owner)
		root := t.TempDir()
		t.Setenv("XDG_CACHE_HOME", root)
		api := &e2eAPI{API: f}
		documents, err := e2eRun(t, api, "upgrade", false)
		if err != nil || len(documents) != 1 {
			t.Fatal(documents, err)
		}
		var preview struct {
			Status string      `json:"status"`
			Plan   upgradePlan `json:"plan"`
		}
		if json.Unmarshal(documents[0], &preview) != nil {
			t.Fatal("invalid preview")
		}
		e2eEqual(t, preview.Status, "preview")
		e2eEqual(t, preview.Plan.MemberID, int64(42))
		if preview.Plan.Compatibility == "" || len(preview.Plan.Changes) == 0 ||
			!strings.Contains(preview.Plan.HostAdoption, "separate trusted operation") {
			t.Fatal(preview.Plan)
		}
		entries, err := os.ReadDir(root)
		if err != nil || len(entries) != 0 {
			t.Fatal("preview installed cache", err)
		}
		e2eEqual(t, e2eSafeWrites(t, api.calls), 0)
	})
}

func TestE2EUpgradeApply(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		for _, lost := range []string{"", "/git/trees", "/git/commits", "/git/refs",
			"/pulls"} {
			f := e2eUpgrade(t, owner)
			if lost != "" {
				f.lost = e2eRepo + lost
			}
			api := &e2eAPI{API: f}
			documents, err := e2eRun(t, api, "upgrade", true)
			if err != nil {
				t.Fatal(err)
			}
			result := e2eUpgradeResult(t, documents)
			e2eEqual(t, result.Status, "pending")
			observed := f.data[e2eRepo+"/pulls/9"].(upgradePull)
			e2eEqual(t, result.PR, observed.URL)
			e2eEqual(t, observed.Base.Ref, "main")
			e2eEqual(t, observed.Head.Ref, "nibfin/upgrade")
			e2eEqual(t, observed.State, "open")
			commit := f.data[e2eRepo+"/git/commits/"+observed.Head.SHA].(upgradeCommit)
			tree, err := readUpgradeTree(api, e2eRepo, commit.Tree.SHA)
			if err != nil {
				t.Fatal(err)
			}
			e2eEqual(t, tree["user.txt"], f.baseEntries["user.txt"])
			if _, exists := tree[".github/workflows/nibfin-stage.yml"]; exists {
				t.Fatal("obsolete stage retained")
			}
			// The output's proposed contents must match provider objects, not a second
			// implementation of the CLI's upgrade rules.
			var preview struct {
				Plan upgradePlan `json:"plan"`
			}
			if json.Unmarshal(documents[0], &preview) != nil {
				t.Fatal("invalid plan")
			}
			for _, change := range preview.Plan.Changes {
				entry, exists := tree[change.Path]
				if change.Kind == "deleted" {
					if exists {
						t.Fatal("deleted path retained", change.Path)
					}
				} else {
					if !exists || entry.SHA != blobHash([]byte(change.Content)) ||
						entry.Mode != "100644" {
						t.Fatal("provider content mismatch", change.Path)
					}
				}
			}
			writes := e2eSafeWrites(t, api.calls)
			e2eEqual(t, writes, 4)
			documents, err = e2eRun(t, api, "upgrade", true)
			if err != nil {
				t.Fatal("repeat", err)
			}
			e2eEqual(t, e2eUpgradeResult(t, documents).PR, result.PR)
			e2eEqual(t, e2eSafeWrites(t, api.calls), writes)
		}
		f := upgradeFixture(t, true, true)
		f.target = f.old
		pins, _ := json.Marshal(f.old)
		f.data["repos/"+officialCLI+"/contents/internal/cli/producers.json?ref="+
			strings.Repeat("5", 40)] = encoded(pins)
		api := &e2eAPI{API: f}
		documents, err := e2eRun(t, api, "upgrade", true)
		if err != nil {
			t.Fatal(err)
		}
		e2eEqual(t, e2eUpgradeResult(t, documents).Status, "no_change")
		e2eEqual(t, e2eSafeWrites(t, api.calls), 0)
	})
}

func TestE2EUpgradeDenials(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		for _, kind := range []string{"edited", "unrecognized", "source", "permission",
			"archive", "branch"} {
			t.Run(kind, func(t *testing.T) {
				f := e2eUpgrade(t, owner)
				switch kind {
				case "edited":
					replaceInstalledFile(t, f, ".github/workflows/nibfin-wake.yml",
						"operator replacement", "100644")
				case "unrecognized":
					replaceInstalledFile(t, f, ".nibfin/producer-pins.json", "{}", "100644")
				case "source":
					delete(f.data, "repos/"+officialCore+"/commits/"+f.old.Core.Commit)
				case "archive":
					path := fmt.Sprintf("repos/%s/actions/artifacts/%d/zip",
						officialCore, f.target.Artifact.ID)
					f.data[path] = []byte("tampered source archive")
				case "permission":
					repo := f.data[e2eRepo].(Repository)
					repo.Permissions["push"] = false
					f.data[e2eRepo] = repo
				case "branch":
					ref := reference{Ref: "refs/heads/nibfin/upgrade"}
					ref.Object.SHA = strings.Repeat("e", 40)
					f.data[e2eRepo+"/git/ref/heads/"+url.PathEscape("nibfin/upgrade")] = ref
				}
				api := &e2eAPI{API: f}
				_, err := e2eRun(t, api, "upgrade", true)
				if err == nil {
					t.Fatal("unsafe upgrade accepted", kind)
				}
				e2eEqual(t, e2eSafeWrites(t, api.calls), 0)
			})
		}
	})
}

func TestE2EUpgradeUnknown(t *testing.T) {
	e2eOwners(t, func(t *testing.T, owner string) {
		f := e2eUpgrade(t, owner)
		f.lost = e2eRepo + "/pulls"
		f.denyAfterWrite = pullListPath(upgradeBranchName)
		api := &e2eAPI{API: f}
		documents, err := e2eRun(t, api, "upgrade", true)
		if err == nil {
			t.Fatal("unknown write cannot pass")
		}
		result := e2eUpgradeResult(t, documents)
		e2eEqual(t, result.Status, "pending")
		e2eEqual(t, result.Code, "UPGRADE_PR_UNKNOWN_READ_BACK_BEFORE_RETRY")
		count := 0
		for _, call := range api.calls {
			if call.Method == "POST" && call.Path == f.lost {
				count++
			}
		}
		e2eEqual(t, count, 1)
		e2eSafeWrites(t, api.calls)
	})
}
