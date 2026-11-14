package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"

	cli "github.com/taco3064/gh-nibfin/internal/cli"
)

type observation struct {
	Command string `json:"command"`
	Exit    int    `json:"exit"`
	// Producer JSON is decoded as a stream; previews are retained.
	Results       []map[string]any `json:"results"`
	Local         bool             `json:"localConfiguration"`
	LocalIdentity map[string]any   `json:"localIdentity"`
	Native        []cli.RunnerInfo `json:"native"`
	Writes        int              `json:"writes"`
	HostCalls     int              `json:"hostCalls"`
}

type caseResult struct {
	Case         string        `json:"case"`
	Observations []observation `json:"observations"`
}

func observe(app cli.App, p *provider, directory, command string) observation {
	args := []string{"runner", command, "--repo", repository}
	if command == "preflight" {
		args = []string{"preflight", "--repo", repository, "--directory", directory}
	} else if command != "list" {
		args = append(args, "--directory", directory, "--apply")
		if command == "create" {
			args = append(args, "--name", "controlled-runner")
		}
	}
	var output bytes.Buffer
	err := app.Run(args, &output)
	code := 0
	if err != nil {
		code = 1
		var commandError *cli.CommandError
		if errors.As(err, &commandError) {
			code = commandError.Exit
		}
	}
	decoder := json.NewDecoder(&output)
	results := []map[string]any{}
	for {
		var value map[string]any
		err := decoder.Decode(&value)
		if err == io.EOF {
			break
		}
		if err != nil {
			panic("CONTROLLED_OUTPUT_INVALID")
		}
		// Package metadata has no credentials; never export raw provider errors.
		results = append(results, value)
	}
	_, localErr := os.Stat(filepath.Join(directory, ".runner"))
	native := append([]cli.RunnerInfo{}, p.runners...)
	identity := map[string]any{}
	if localErr == nil {
		data, err := os.ReadFile(filepath.Join(directory, ".runner"))
		if err != nil || json.Unmarshal(data, &identity) != nil {
			panic("CONTROLLED_LOCAL_IDENTITY_UNAVAILABLE")
		}
	}
	return observation{command, code, results, localErr == nil, identity,
		native, p.writes, p.calls}
}

func runCase(kind string) caseResult {
	root, err := os.MkdirTemp("", "nibfin-controlled-runner-")
	if err != nil {
		panic("CONTROLLED_DIRECTORY_UNAVAILABLE")
	}
	// All effects are in-memory or in this freshly allocated directory. No native
	// process or registration is created, including in unresolved-input cases.
	defer func() {
		if os.RemoveAll(root) != nil {
			panic("CONTROLLED_CLEANUP_INCOMPLETE")
		}
	}()
	directory := filepath.Join(root, "runner")
	p := &provider{}
	app := controlledApp(p)
	result := caseResult{Case: kind}
	add := func(command string) {
		result.Observations = append(result.Observations,
			observe(app, p, directory, command))
	}
	add("create")
	switch kind {
	case "denied":
		p.admin = false
	case "member":
		path := filepath.Join(directory, ".nibfin-runner.json")
		data, err := os.ReadFile(path)
		if err != nil {
			panic("CONTROLLED_RECORD_UNAVAILABLE")
		}
		var record map[string]any
		if json.Unmarshal(data, &record) != nil {
			panic("CONTROLLED_RECORD_INVALID")
		}
		record["member_id"] = 99
		data, _ = json.Marshal(record)
		if os.WriteFile(path, data, 0600) != nil {
			panic("CONTROLLED_RECORD_WRITE_FAILED")
		}
	case "repository", "label", "unknown", "runtime":
		p.mode = kind
	}
	add("register")
	add("list")
	switch kind {
	case "remove":
		add("remove")
		add("unregister")
	case "registered":
		add("unregister")
	case "busy", "active", "service", "mismatched":
		if kind == "busy" {
			p.runners[0].Busy = true
		}
		if kind == "active" {
			p.runners[0].Status = "online"
		}
		if kind == "mismatched" {
			p.runners[0].ID = 99
		}
		if kind == "service" {
			if os.WriteFile(filepath.Join(directory, ".service"), []byte("owned"),
				0600) != nil {
				panic("CONTROLLED_SERVICE_INPUT_FAILED")
			}
		}
		add("unregister")
	case "unknown":
		add("register")
	}
	if kind == "tools" || kind == "docker" || kind == "package" {
		p.mode = kind
	}
	add("preflight")
	return result
}

func main() {
	if runtime.GOOS != "linux" ||
		(runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		panic("CONTROLLED_HOST_UNSUPPORTED")
	}
	cases := []caseResult{}
	for _, kind := range []string{"registered", "remove", "denied", "repository",
		"label", "unknown", "runtime", "member", "busy", "active", "service", "mismatched",
		"tools", "docker", "package"} {
		cases = append(cases, runCase(kind))
	}
	if json.NewEncoder(os.Stdout).Encode(map[string]any{
		"evidence": "controlled", "repository": repository, "memberId": 9,
		"protectedExecution": "unverified", "cases": cases}) != nil {
		panic("CONTROLLED_OUTPUT_UNAVAILABLE")
	}
}
