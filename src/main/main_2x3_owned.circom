pragma circom 2.0.0;

// Entry point for the owned 2x3 circuit shape (2 nullifiers, 3 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(2, 3);
