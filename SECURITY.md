# Security Policy

## Supported Versions

verdex is pre-1.0. Only the latest minor release line receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

Versions before 0.3.0 copy an own `"__proto__"` key in `input` or `data` with plain assignment when they snapshot a query, which replaces the copy's prototype and can change a policy decision. Upgrade to 0.3.0 or later; on older versions, give every module an input schema that strips unknown keys and keep request-derived JSON out of `data`.

## Reporting a Vulnerability

If you discover a security vulnerability within verdex, please report it responsibly.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report it privately through one of these channels:

- **Preferred:** Open a private report via GitHub Security Advisories using the **"Report a vulnerability"** button on the [Security tab](https://github.com/rayhanadev/verdex/security/advisories) of the verdex repo.
- **Fallback:** Send an email to me@rayhanadev.com.

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
