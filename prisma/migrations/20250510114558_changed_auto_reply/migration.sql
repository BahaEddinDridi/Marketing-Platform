/*
  Warnings:

  - The `mailbox` column on the `AutoReplyConfig` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `name` to the `AutoReplyConfig` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AutoReplyConfig" ADD COLUMN     "description" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
DROP COLUMN "mailbox",
ADD COLUMN     "mailbox" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "isActive" SET DEFAULT false;
