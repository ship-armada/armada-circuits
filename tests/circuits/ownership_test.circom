pragma circom 2.0.0;

// Test-only entry point: exposes NullifierOwnership so the tests can run it on real spends.
include "../../src/operations/NullifierDisclosure.circom";

component main = NullifierOwnership();
