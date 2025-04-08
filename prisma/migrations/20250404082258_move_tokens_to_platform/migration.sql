/*
  Warnings:

  - You are about to drop the column `accessToken` on the `Organization` table. All the data in the column will be lost.
  - You are about to drop the column `refreshToken` on the `Organization` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "accessToken",
DROP COLUMN "refreshToken";
