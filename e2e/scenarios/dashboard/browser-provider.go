package main

import (
	"context"
	"errors"

	"github.com/taco3064/gh-nibfin/internal/pause"
	"github.com/taco3064/gh-nibfin/internal/snapshot"
)

func targetOf(i snapshot.Identity) pause.Target {
	return pause.Target{RepositoryID: i.Repository.ID, IssueID: i.ID, Number: i.Number}
}

func (f *fixture) Collect(string) snapshot.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	v := f.Snapshot
	v.Issues.Items = append([]snapshot.Issue(nil), v.Issues.Items...)
	for i := range v.Issues.Items {
		row := &v.Issues.Items[i]
		row.PauseLabel = &snapshot.PauseLabel{
			Present: f.paused[targetOf(row.Identity)], Actor: "Unknown"}
	}
	return v
}

func (f *fixture) Inspect(ctx context.Context, repo string,
	target pause.Target) (pause.Facts, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ctx.Err() == nil {
		for _, row := range f.Snapshot.Issues.Items {
			if repo == row.Identity.Repository.Name && target == targetOf(row.Identity) {
				subject := f.Overviews[f.index].Subject
				return pause.Facts{User: pause.User{ID: subject.ID, Login: subject.Login},
					Target: target, Title: row.Title, Open: row.State == "open", Scoped: true,
					Owner: true, Paused: f.paused[target]}, nil
			}
		}
	}
	return pause.Facts{}, errors.New("fixture selection unavailable")
}

func (f *fixture) Edit(ctx context.Context, repo string,
	target pause.Target, action pause.Action) error {
	if _, err := f.Inspect(ctx, repo, target); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.paused[target] = action == pause.Pause
	return nil
}
