package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	cli "github.com/taco3064/gh-nibfin/internal/cli"
)

const repository = "example/project"
const sentinel = "controlled-secret-never-export"

type provider struct {
	application cli.RunnerApplication
	runners     []cli.RunnerInfo
	admin       bool
	mode        string
	writes      int
	calls       int
}

func assign(out, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func (p *provider) Call(method, path string, input, out any) error {
	base := "repos/" + repository + "/actions/runners"
	switch {
	case method == "GET" && path == "repos/"+repository:
		return assign(out, cli.Repository{ID: 7, FullName: repository,
			Owner:       cli.User{ID: 9, Type: "User"},
			Permissions: map[string]bool{"admin": p.admin}})
	case method == "GET" && path == "user":
		return assign(out, cli.User{ID: 9, Login: "controlled", Type: "User"})
	case method == "GET" && path == base+"/downloads":
		if p.mode == "package" {
			return errors.New("NOT_FOUND")
		}
		return assign(out, []cli.RunnerApplication{p.application})
	case method == "GET" && strings.HasPrefix(path, base+"?per_page="):
		return assign(out, map[string]any{
			"total_count": len(p.runners), "runners": p.runners})
	case method == "GET" && path == base+"/42":
		if len(p.runners) == 0 {
			return errors.New("NOT_FOUND")
		}
		return assign(out, p.runners[0])
	case method == "POST" && (path == base+"/registration-token" ||
		path == base+"/remove-token"):
		p.writes++
		return assign(out, map[string]string{"token": sentinel,
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	case method == "DELETE" && path == base+"/42":
		p.writes++
		p.runners = []cli.RunnerInfo{}
		return nil
	}
	return errors.New("CONTROLLED_UNEXPECTED_API_CALL")
}

func (p *provider) Check(string) error {
	if p.mode == "runtime" {
		return errors.New("RUNTIME_UNAVAILABLE")
	}
	return nil
}

func (p *provider) Configure(root, command string, inputs map[string]string) error {
	p.calls++
	if command == "configure" {
		runner := cli.RunnerInfo{ID: 42, Name: inputs["NAME"], Status: "offline"}
		label := inputs["LABELS"]
		if p.mode == "label" {
			label = "nibfin-user-99"
		}
		runner.Labels = append(runner.Labels, struct {
			Name string `json:"name"`
		}{Name: label})
		p.runners = []cli.RunnerInfo{runner}
		url := inputs["URL"]
		if p.mode == "repository" {
			url = "https://github.com/other/project"
		}
		data, _ := json.Marshal(map[string]any{
			"agentId": 42, "agentName": runner.Name, "gitHubUrl": url})
		if err := os.WriteFile(filepath.Join(root, ".runner"), data, 0600); err != nil {
			return err
		}
	} else {
		p.runners = []cli.RunnerInfo{}
		if err := os.Remove(filepath.Join(root, ".runner")); err != nil {
			return err
		}
	}
	if p.mode == "unknown" {
		return errors.New("RUNNER_TIMEOUT_RESULT_UNKNOWN")
	}
	return nil
}

func (p *provider) Run(tool string, args []string, input []byte) ([]byte, error) {
	if p.mode == "tools" {
		return nil, errors.New("TOOL_UNAVAILABLE")
	}
	if tool == "codex" && args[0] == "login" {
		return []byte("chatgpt"), nil
	}
	if tool != "docker" {
		return []byte("controlled version"), nil
	}
	if p.mode == "docker" {
		return nil, errors.New("TOOL_UNAVAILABLE")
	}
	switch strings.Join(args, " ") {
	case "context show":
		return []byte("default"), nil
	case "context inspect default":
		return []byte(`[{"Endpoints":{"docker":{"Host":"unix:///controlled"}}}]`), nil
	default:
		return []byte(`{"OSType":"linux","SecurityOptions":["name=apparmor"]}`), nil
	}
}
