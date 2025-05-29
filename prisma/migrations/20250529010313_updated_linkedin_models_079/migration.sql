/*
  Warnings:

  - You are about to drop the column `cost_type` on the `LinkedInMetadata` table. All the data in the column will be lost.
  - You are about to drop the column `format` on the `LinkedInMetadata` table. All the data in the column will be lost.
  - You are about to drop the column `objective` on the `LinkedInMetadata` table. All the data in the column will be lost.
  - You are about to drop the column `optimization_target` on the `LinkedInMetadata` table. All the data in the column will be lost.
  - You are about to drop the column `pacing_strategy` on the `LinkedInMetadata` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `LinkedInMetadata` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LinkedInMetadata" DROP COLUMN "cost_type",
DROP COLUMN "format",
DROP COLUMN "objective",
DROP COLUMN "optimization_target",
DROP COLUMN "pacing_strategy",
DROP COLUMN "type";
