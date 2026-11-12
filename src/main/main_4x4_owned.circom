pragma circom 2.0.0;

// Entry point for the owned 4x4 circuit shape (4 nullifiers, 4 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(4, 4);
