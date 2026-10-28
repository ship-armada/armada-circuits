pragma circom 2.0.0;

// Entry point for the owned 5x3 circuit shape (5 nullifiers, 3 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(5, 3);
