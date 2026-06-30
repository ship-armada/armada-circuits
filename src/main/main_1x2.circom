pragma circom 2.0.0;

// Entry point for the 1x2 circuit shape (1 nullifier, 2 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitments]} = Transact(1, 2);
