pragma circom 2.0.0;

// Entry point for the owned 6x2 circuit shape (6 nullifiers, 2 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(6, 2);
