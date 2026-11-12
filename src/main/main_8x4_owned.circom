pragma circom 2.0.0;

// Entry point for the owned 8x4 circuit shape (8 nullifiers, 4 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(8, 4);
