package main

import "testing"

func TestUsageMentionsAllCommands(t *testing.T) {
	for _, cmd := range []string{"restore", "watch", "status", "check"} {
		if !contains(usage, cmd) {
			t.Errorf("usage missing command %q", cmd)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
