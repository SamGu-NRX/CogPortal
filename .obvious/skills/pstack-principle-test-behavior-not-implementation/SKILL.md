---
name: pstack-principle-test-behavior-not-implementation
description: "Apply when you write, change, or keep a test. Call the code the way its users do and assert the result they observe against a literal expected value. Use an undefined-result mutation to inspect coverage; preserve specified empty results and observable side effects."
disable-model-invocation: true
---

# Test Behavior, Not Implementation

A test calls the code the way its users do and asserts the result they observe against a literal expected value. A test that asserts which calls the code made, or restates a constant the code contains, does neither.

Before keeping a test, replace the subject's returned value with `undefined` and check the actual assertion. Passing that mutation is a warning to inspect coverage, not proof that the test is useless. Some contracts require absence, and side effects can be observable independently of a return value.

**Why:** A test that cannot fail for a defect costs CI time and review attention and catches nothing. A constant pin also fails when someone edits the constant or the prompt it restates, so it prevents that edit.

**Assertions that can pass without useful output:**

- No assertion, or only `not.toThrow` on a subject whose no-op replacement also does not throw.
- `toBeUndefined` or `not.toBe(wrongValue)` without an input that demonstrates the expected presence or value.
- `expect(f(a)).toBe(f(a))`, where both sides come from the subject and become `undefined` together.
- An assertion that reads only a fixture and never exercises the subject.

**Assertions that reject an `undefined` result:** `toBeDefined`, `toBeTruthy`, `toBeInstanceOf`, `toBeGreaterThan(0)`, `toEqual([])`, and `toHaveLength(0)` when applied to that result. They still need inputs that exercise the contract. Empty-result assertions are useful when an empty collection is the specified behavior.

**Other coverage questions:** A mock-call assertion can fail under the mutation if the subject normally makes that call. Check the payload or observable effect when that is the contract. A constant assertion may pass because the mutation changes functions rather than constants; judge whether it protects a real external contract before removing it.

**The fix:** call the subject inside the test body with one concrete input and assert the literal output or the observable effect, `expect(slugify("Hello, World!")).toBe("hello-world")`. For an absence, assert the presence on the other input in the same test. For a constant, test the mechanism that reads it with one input instead of restating the value. For a mock, assert the payload it received or the state after the call, not that it was called. When no such assertion exists, delete the test.

**Keep** a test of a relation across a table's rows (a key present in two tables, a parent that exists), and a compile-time check in a `*.test-d.ts` file.
