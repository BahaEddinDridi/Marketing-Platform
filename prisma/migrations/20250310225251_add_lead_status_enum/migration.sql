/*
  Warnings:

  - Changed the type of `status` on the `Lead` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'IN_PROGRESS', 'CONVERTED', 'CLOSED');

-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "status",
ADD COLUMN     "status" "LeadStatus" NOT NULL;
