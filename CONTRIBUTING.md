# Contributing

## Workflow

1. Read `strategies-docs/README.md` and `strategies-docs/08-progress-and-decisions.md`.
2. Work on the earliest incomplete milestone whose dependencies are complete.
3. Preserve integer token amounts, explicit chain/token identity, evidence-derived phases, and
   deterministic idempotency keys.
4. Add or update tests for every behavior change, including negative and recovery cases.
5. Run `npm run check` before submitting a change.
6. Update the progress journal with commands, results, decisions, and remaining risks.

## Security

Never commit credentials, private keys, production wallet material, or user-supplied AI keys.
Report security-sensitive findings privately to the project owner rather than opening a public
issue containing exploit details.
