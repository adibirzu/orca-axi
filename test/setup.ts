/**
 * Test-process hygiene: the resolver reads ORCA_* environment hooks, so a
 * developer shell that exports them must not leak into the suite. Individual
 * tests save and restore what they set.
 */
for (const name of ["ORCA_CLI_COMMAND", "ORCA_AXI_PLATFORM", "ORCA_AXI_HOME"]) {
  delete process.env[name];
}
