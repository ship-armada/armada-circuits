pragma circom 2.0.0;

// Entry point for the 2x2 circuit shape (2 nullifiers, 2 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = Transact(2, 2);
