//go:build linux

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type e2eManagedBinding struct {
	Owner        string   `json:"owner"`
	HostID       string   `json:"hostId"`
	Repositories []string `json:"repositories"`
	MemberID     int64    `json:"memberId"`
}

// All provider and host records are fixture-owned, independent of CLI output.
// Only real orchestration can update the disposable durable installation intent.
type e2eManaged struct {
	t          *testing.T
	binding    e2eManagedBinding
	api        *fakeAPI
	transport  *e2eAPI
	plan       InitPlan
	pull       map[string]any
	merge      func()
	host       *sharedHost
	slots      []sharedRegistration
	services   map[string]string
	counts     map[string]int
	member     int64
	loginPath  string
	unresolved bool
	interrupt  bool
	secretPath string
	token      []byte
	out        bytes.Buffer
}

func e2eManagedFixture(t *testing.T) *e2eManaged {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(home, "managed-fixture.json"))
	var binding e2eManagedBinding
	if err != nil || json.Unmarshal(data, &binding) != nil ||
		len(binding.Repositories) != 2 || binding.Owner == "" ||
		!strings.HasPrefix(binding.HostID, "simulation-") || binding.MemberID != 7 {
		t.Fatal("owned simulation binding required", err)
	}
	root := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "cache"))
	api, _, _ := managedResumeFixture(t)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	// Reuse producer source/transport setup, give the simulation its own A/B names.
	original := "repos/example/project"
	repo := api.data[original].(Repository)
	repo.FullName = binding.Repositories[0]
	repo.Owner = User{ID: binding.MemberID, Login: "e2e-managed", Type: "User"}
	api.data["user"] = repo.Owner
	for path, value := range api.data {
		if strings.HasPrefix(path, original) {
			delete(api.data, path)
			// Only repository metadata, labels and initial ref are reused.
			if path == original || strings.Contains(path, "/labels/") ||
				path == original+"/git/ref/heads/main" {
				api.data[strings.Replace(path, original, "repos/"+repo.FullName, 1)] = value
			}
		}
	}
	api.data["repos/"+repo.FullName] = repo
	transport := &e2eAPI{API: api}
	plan, err := planInitWithExecution(transport, repo.FullName, repo.FullName)
	if err != nil {
		t.Fatal(err)
	}
	f := &e2eManaged{t: t, binding: binding, api: api, transport: transport,
		plan: plan, counts: map[string]int{}, member: binding.MemberID,
		services:   map[string]string{},
		token:      []byte("synthetic-managed-credential-119"),
		secretPath: filepath.Join(root, "staged-login"),
		loginPath:  filepath.Join(root, "stored-login")}
	if err := os.WriteFile(f.loginPath, f.token, 0600); err != nil {
		t.Fatal(err)
	}
	f.pull, f.merge = f.proposal(plan)
	t.Cleanup(func() { clear(f.token) })
	return f
}

func (f *e2eManaged) proposal(plan InitPlan) (map[string]any, func()) {
	base := "repos/" + plan.Repository.FullName
	branch := "nibfin/init-" + plan.Head[:12]
	head, merged := strings.Repeat("b", 40), strings.Repeat("c", 40)
	query := base + "/pulls?state=all&per_page=2&head=" +
		url.QueryEscape(plan.Repository.Owner.Login+":"+branch)
	f.api.data[query] = []map[string]int{{"number": 7}}
	pull := map[string]any{
		"number": 7, "html_url": "https://github.com/" + plan.Repository.FullName + "/pull/7",
		"state": "open", "merged": false,
		"head": map[string]any{"ref": branch, "sha": head,
			"repo": map[string]int64{"id": plan.Repository.ID}},
		"base": map[string]any{"ref": "main",
			"repo": map[string]int64{"id": plan.Repository.ID}},
	}
	f.api.data[base+"/pulls/7"] = pull
	f.api.data[base+"/actions/variables/"+sharedPoolVariable] =
		actionsVariable{Name: sharedPoolVariable, Value: "false"}
	for _, file := range plan.Files {
		f.api.data[base+"/contents/"+file.Path+"?ref="+head] = encoded([]byte(file.Content))
	}
	return pull, func() {
		pull["state"], pull["merged"] = "closed", true
		ref := reference{Ref: "refs/heads/main"}
		ref.Object.SHA = merged
		f.api.data[base+"/git/ref/heads/main"] = ref
		f.api.data[base+"/branches/main"] = map[string]any{"name": "main", "protected": true,
			"commit": map[string]string{"sha": merged}}
		for _, file := range plan.Files {
			f.api.data[base+"/contents/"+file.Path+"?ref="+merged] =
				encoded([]byte(file.Content))
		}
	}
}

func (f *e2eManaged) resume(ctx context.Context, plan InitPlan) error {
	f.out.Reset()
	return (App{API: f.transport, Process: e2eNoProcess{f.t}}).resumeManagedInit(
		ctx, plan, f.token, &f.out, f.operations())
}

func (f *e2eManaged) open(plan InitPlan) managedInstallIntent {
	f.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := f.resume(ctx, plan)
	var pending *CommandError
	if !errors.As(err, &pending) || pending.Code != "MANAGED_INSTALL_AWAITING_PR_MERGE" {
		f.t.Fatal("open proposal must remain pending", err)
	}
	return f.intent(plan)
}

func (f *e2eManaged) intent(plan InitPlan) managedInstallIntent {
	f.t.Helper()
	path, err := managedIntentPath(plan.Repository)
	if err != nil {
		f.t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var intent managedInstallIntent
	if err != nil || json.Unmarshal(data, &intent) != nil || bytes.Contains(data, f.token) {
		f.t.Fatal("missing or unsafe durable intent", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		f.t.Fatal("private intent required", err)
	}
	return intent
}

func (f *e2eManaged) rejected(err error, code string) {
	f.t.Helper()
	if err == nil || !strings.Contains(err.Error(), code) ||
		strings.Contains(f.out.String(), "MANAGED_INSTALLATION_INACTIVE") {
		f.t.Fatal("expected unresolved or rejected handoff", code, err)
	}
	if bytes.Contains(f.out.Bytes(), f.token) {
		f.t.Fatal("credential leaked")
	}
}
