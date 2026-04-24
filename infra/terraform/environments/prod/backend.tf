# Remote state — S3 bucket and DynamoDB table already exist in the
# mypassglobal ops account. No bootstrap steps required.

terraform {
  backend "s3" {
    bucket = "mypassglobal-ops-acct-terraform"

    # State file path within the bucket
    key = "fragile/prod/terraform.tfstate"

    # Update this to match the region where the bucket was created.
    region = "ap-southeast-2"

    dynamodb_table = "mypassglobal-ops-acct-terraform"

    encrypt = true
  }
}
