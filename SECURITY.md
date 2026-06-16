# Security Policy

## Supported Versions

verdex is pre-1.0. Only the latest minor release in the `0.1.x` line receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within verdex, please report it responsibly.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report it privately through one of these channels:

- **Preferred:** Open a private report via GitHub Security Advisories using the **"Report a vulnerability"** button on the [Security tab](https://github.com/rayhanadev/verdex/security/advisories) of the verdex repo.
- **Fallback:** Send an email to ray@million.dev.

You should receive a response within 48 hours. If for some reason you do not, please follow up to ensure your original message was received.

Please include the following information (as much as you can provide) to help us better understand the nature and scope of the issue:

- Type of issue (e.g. prototype pollution, policy bypass, denial of service, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

This information will help us triage your report more quickly.

## Scope

verdex is an authorization and policy engine, so it evaluates untrusted input and attacker-influenced data as a matter of course. Reports involving input and data handling — such as prototype pollution, policy bypass, or unexpected privilege escalation through crafted input — are taken seriously and prioritized accordingly. If you are unsure whether something qualifies, please report it privately and we will help assess it.
