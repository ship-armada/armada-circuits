pragma circom 2.0.0;

// Entry point for the owned 4x3 circuit shape (4 nullifiers, 3 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(4, 3);
