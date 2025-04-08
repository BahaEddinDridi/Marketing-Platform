/*
  Warnings:

  - You are about to drop the column `bodyPreview` on the `LeadEmail` table. All the data in the column will be lost.
  - Added the required column `body` to the `LeadEmail` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "LeadEmail" RENAME COLUMN "bodyPreview" TO "body";
ALTER TABLE "LeadEmail" ALTER COLUMN "body" SET DATA TYPE TEXT;
