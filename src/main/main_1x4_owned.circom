pragma circom 2.0.0;

// Entry point for the owned 1x4 circuit shape (1 nullifier, 4 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(1, 4);
