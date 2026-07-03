pragma circom 2.0.0;

// Entry point for the 6x2 circuit shape (6 nullifiers, 2 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = Transact(6, 2);
