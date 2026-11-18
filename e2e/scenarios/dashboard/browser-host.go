package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/taco3064/gh-nibfin/internal/dashboard"
	"github.com/taco3064/gh-nibfin/internal/pause"
	"github.com/taco3064/gh-nibfin/internal/snapshot"
)

type fixture struct {
	mu        sync.Mutex
	Snapshot  snapshot.Snapshot              `json:"snapshot"`
	Overviews []snapshot.Overview            `json:"overviews"`
	Results   []snapshot.DiagnosisProjection `json:"diagnosis_results"`
	index     int
	diagnoses int
	paused    map[pause.Target]bool
}

func (f *fixture) CollectOverview() snapshot.Overview {
	f.mu.Lock()
	defer f.mu.Unlock()
	v := f.Overviews[f.index]
	now := time.Now().UTC()
	v.ObservedAt, v.ExpiresAt = now, now.Add(30*time.Second)
	v.Runners.Items = append([]snapshot.LocalRunner(nil), v.Runners.Items...)
	for i := range v.Runners.Items {
		r := &v.Runners.Items[i]
		r.Busy.ObservedAt, r.Online.ObservedAt = now, now
		r.Association.ObservedAt = now
	}
	return v
}

func (f *fixture) Diagnose(_ context.Context, _ dashboard.DiagnosisSelection,
	_ snapshot.DiagnosisAttempt, _ bool) *snapshot.DiagnosisProjection {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.diagnoses >= len(f.Results) {
		return snapshot.UnavailableDiagnosis("FIXTURE_EXHAUSTED")
	}
	value := f.Results[f.diagnoses]
	f.diagnoses++
	return &value
}

func run() error {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	f := &fixture{paused: map[pause.Target]bool{}}
	if json.Unmarshal(data, f) != nil || len(f.Overviews) == 0 {
		return fmt.Errorf("invalid controlled fixture")
	}
	fixtureDiagnoses(data, f.Overviews)
	service, err := dashboard.Start(context.Background(), dashboard.Config{
		Overview: f, Repository: f.Snapshot.Repository.Items[0].Name, Provider: f,
		Controller: pause.Controller{Provider: f}, Diagnoser: f,
	})
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintln(os.Stdout, service.BootstrapURL()); err != nil {
		_ = service.Close()
		return err
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		f.mu.Lock()
		if scanner.Text() == "next" && f.index+1 < len(f.Overviews) {
			f.index++
		}
		f.mu.Unlock()
	}
	return service.Close()
}

func main() {
	if run() != nil {
		os.Exit(1)
	}
}
