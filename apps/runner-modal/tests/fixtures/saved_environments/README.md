# Saved platform code

These unedited public source files let shallow CI checkouts test the code an older prepared filesystem preserves.

- `pr8_week3_payload.py`: CogPortal `8871f883a1e2a67988bd28bc570a036dd712c0fd`, `apps/runner-modal/src/cogworks_runner/week3_payload.py`. It constructs six Language cases.
- `pr8_week2_payload.py`: the same CogPortal commit, `apps/runner-modal/src/cogworks_runner/week2_payload.py`.
- `c177_vision_drivers.py`: Week 2 benchmark `c177cf23cdd4f8dbe55401a2eb4bada4c64d37c2`, `facial_recognition_benchmark/drivers.py`. Its shuffled-query path can execute the newer controller's recognition allocation.

The Week 2 driver is copyright 2026 Reynaldo Jose Morillo Nolasco, distributed under the accompanying `LICENSE-week2-benchmark` MIT notice. Its relative imports use the installed benchmark package, so this fixture preserves the driver rather than reproducing an entire old environment.

`test_saved_contract_pairs.py` imports these files by path. Do not modernize them alongside production code. The Language golden compares the old decoder with the checked-out decoder. The recognition-v2 matrix needs PR19's current encoder and benchmark allocation; earlier branches explicitly skip that integration test.
