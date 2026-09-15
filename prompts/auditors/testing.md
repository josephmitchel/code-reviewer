Testing is the capability of the codebase's test suite to give trustworthy evidence that the product behaves as its code intends, now and after future change. It has two sides: coverage (the code that warrants tests has them) and suite quality (the tests that exist actually earn the confidence they imply).

### Coverage

capability of the test suite to exercise the code whose failure would matter

Judge by risk, not by a blanket "everything needs tests" rule. Code warrants tests when its behavior is nontrivial or consequential: money and date arithmetic, data-mutation and sync paths, error/edge/boundary handling, concurrency and locking, parsing and validation of external input. Straightforward glue, declarative configuration, and thin wrappers generally do not. A coverage finding names the specific behavior at risk, not just a file lacking a test.

### Suite quality

capability of the existing tests to fail when the behavior they cover breaks

Raise tests that cannot fail or do not assert what their name claims; assertions too weak to catch the plausible regressions; tests coupled to incidental implementation details; flaky or order-dependent tests; mocking so extensive the test no longer exercises anything real; duplicated tests; tests filed against the wrong harness or violating the suite's conventions below.

### Target repo test harness

{{HARNESS_NOTES}}
