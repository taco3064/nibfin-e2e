package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/taco3064/gh-nibfin/internal/dashboard"
	"github.com/taco3064/gh-nibfin/internal/pause"
	"github.com/taco3064/gh-nibfin/internal/snapshot"
)

type e2eDashboardFacts struct {
	DatabaseID   int64                     `json:"databaseId"`
	Subject      snapshot.Subject          `json:"subject"`
	Identity     snapshot.LocalIssue       `json:"identity"`
	Attempt      snapshot.DiagnosisAttempt `json:"attempt"`
	Observations []string                  `json:"observations"`
	Diagnoses    []string                  `json:"diagnoses"`
}

func e2eFacts(t *testing.T) e2eDashboardFacts {
	t.Helper()
	var facts e2eDashboardFacts
	data, err := os.ReadFile(os.Getenv("E2E_DASHBOARD_FACTS"))
	if err != nil || json.Unmarshal(data, &facts) != nil {
		t.Fatal("fixture facts unavailable", err)
	}
	return facts
}

type e2eDashboardAPI struct {
	facts   e2eDashboardFacts
	changed string
	paused  bool
}

func (a *e2eDashboardAPI) Call(method, path string, input, output any) error {
	if method != "GET" || input != nil {
		return errors.New("unexpected API mutation")
	}
	f := a.facts
	name, id, node := f.Identity.Repository, f.Identity.RepositoryID, f.Identity.ID
	if strings.Contains(path, "other/project") {
		name, id, node = "other/project", 3, "I_foreign"
	}
	base := "repos/" + name
	if a.changed == "repository" {
		id++
	}
	if a.changed == "node" {
		node = "I_changed"
	}
	issuePath := base + "/issues/" + strconv.Itoa(f.Identity.Number)
	issue := map[string]any{"id": f.DatabaseID, "node_id": node,
		"number": f.Identity.Number,
		"title":  "Assigned controlled work", "state": "open",
		"url": "https://api.github.com/" + issuePath,
		"html_url": "https://github.com/" + name + "/issues/" +
			strconv.Itoa(f.Identity.Number),
		"repository_url": "https://api.github.com/" + base,
		"assignees":      []snapshot.Subject{f.Subject},
		"labels":         []map[string]string{{"name": "scope"}}}
	if a.paused {
		issue["labels"] = []map[string]string{{"name": "scope"}, {"name": "pause"}}
	}
	var value any
	switch {
	case path == "user":
		user := map[string]any{"id": f.Subject.ID, "login": f.Subject.Login,
			"type": "User"}
		if a.changed == "subject" {
			user["id"] = f.Subject.ID + 1
		}
		value = user
	case path == base:
		value = map[string]any{"id": id, "full_name": name, "private": false,
			"owner": map[string]any{"id": f.Subject.ID, "login": f.Subject.Login,
				"type": "User"},
			"permissions": map[string]bool{"pull": true, "push": true}}
	case strings.HasPrefix(path, base+"/issues?"):
		value = []any{issue}
	case path == issuePath:
		value = issue
	default:
		return errors.New("unexpected fixture API path: " + path)
	}
	data, _ := json.Marshal(value)
	return json.Unmarshal(data, output)
}

type e2eDashboardProcess struct {
	t         *testing.T
	mode      string
	api       *e2eDashboardAPI
	edits     int
	ambiguous bool
	requests  int
}

func (p *e2eDashboardProcess) Run(name string, args []string,
	input []byte) ([]byte, error) {
	return p.RunContext(context.Background(), name, args, input)
}

func (p *e2eDashboardProcess) RunContext(ctx context.Context, name string,
	args []string, input []byte) ([]byte, error) {
	if name == "gh" {
		if reflect.DeepEqual(args, []string{"auth", "token", "--hostname", "github.com"}) {
			return []byte("synthetic-dashboard"), nil
		}
		flag := "--add-label"
		if p.api.paused {
			flag = "--remove-label"
		}
		want := []string{"issue", "edit", strconv.Itoa(p.api.facts.Identity.Number), "--repo",
			p.api.facts.Identity.Repository, flag, "pause"}
		if !reflect.DeepEqual(args, want) || input != nil {
			p.t.Fatal("action redirected or broadened", args)
		}
		p.edits++
		if p.ambiguous {
			return nil, errors.New("controlled unknown effect")
		}
		p.api.paused = !p.api.paused
		return nil, nil
	}
	if len(args) != 2 || name != "fixture-node" || args[0] != "fixture-core" {
		p.t.Fatal("unexpected process", name, args)
	}
	if args[1] == "help" {
		if p.mode == "unavailable" {
			return []byte(`{"commands":[]}`), nil
		}
		return []byte(`{"commands":["observe-local-work","request-local-diagnosis"]}`), nil
	}
	p.requests++
	var body any
	if json.Unmarshal(input, &body) != nil {
		p.t.Fatal("invalid private input")
	}
	data, _ := json.Marshal(map[string]any{"operation": args[1],
		"mode": p.mode, "input": body})
	cmd := exec.CommandContext(ctx, os.Getenv("E2E_NODE"), os.Getenv("E2E_BRIDGE"))
	cmd.Stdin = bytes.NewReader(data)
	return cmd.Output()
}

func e2eResolve() (string, string, error) { return "fixture-node", "fixture-core", nil }

func e2eSelection(f e2eDashboardFacts) dashboard.DiagnosisSelection {
	return dashboard.DiagnosisSelection{Identity: snapshot.Identity{
		Repository: snapshot.Repository{ID: f.Identity.RepositoryID,
			Name: f.Identity.Repository}, ID: f.DatabaseID, Number: f.Identity.Number,
		URL: "https://github.com/" + f.Identity.Repository + "/issues/" +
			strconv.Itoa(f.Identity.Number)},
		NodeID: f.Identity.ID, Subject: f.Subject}
}

func e2ePause(api *e2eDashboardAPI, p *e2eDashboardProcess) pause.Controller {
	return pause.Controller{Provider: NativePause{API: api, Process: p}}
}
