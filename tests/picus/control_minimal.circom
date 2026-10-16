pragma circom 2.0.0;
// Control: an output assigned with <-- and never constrained. Picus must report it unsafe.
template Tiny() {
  signal input a;
  signal input b;
  signal output c;
  c <-- a + b;
}
component main = Tiny();
