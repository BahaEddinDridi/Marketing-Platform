/*
  Warnings:

  - You are about to drop the column `access_token` on the `PlatformCredentials` table. All the data in the column will be lost.
  - You are about to drop the column `token_expiry` on the `PlatformCredentials` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PlatformCredentials" DROP COLUMN "access_token",
DROP COLUMN "token_expiry";
