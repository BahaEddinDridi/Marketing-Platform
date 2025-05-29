/*
  Warnings:

  - Added the required column `accountUrn` to the `AdAccount` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AdAccount" ADD COLUMN     "accountUrn" TEXT NOT NULL;
