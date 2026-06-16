---
name: Bug report
about: Report a problem with verdex
title: ""
labels: bug
assignees: ""
---

**Describe the bug**
A clear and concise description of what the bug is. If it relates to a security issue (e.g. prototype pollution, policy bypass), please follow `SECURITY.md` instead of filing a public issue.

**To Reproduce**
A minimal reproduction is the fastest way to a fix. Please include:

1. The policy/rule definition involved
2. The input/context being evaluated
3. The query you made (e.g. `engine.authz.allow({ input })`)
4. The result you got

```ts
// Minimal repro
```

**Expected behavior**
A clear and concise description of what you expected to happen (e.g. expected `allow`, got `deny`).

**Environment**

- verdex version: [e.g. 0.1.0]
- Runtime: [e.g. Bun 1.x, Node 22]
- TypeScript version: [e.g. 5.x]
- OS: [e.g. macOS 15]

**Additional context**
Add any other context about the problem here.
