pragma circom 2.0.0;

// Entry point for the owned 3x2 circuit shape (3 nullifiers, 2 commitments)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(3, 2);
