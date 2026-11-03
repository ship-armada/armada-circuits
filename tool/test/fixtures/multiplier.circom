pragma circom 2.0.0;

// Tiny test circuit for the ceremony tooling's snarkjs integration tests.
// It proves knowledge of a and b with a * b == c; it is never used on-chain.

template Multiplier() {
  signal input a;
  signal input b;
  signal output c;
  c <== a * b;
}

component main = Multiplier();
