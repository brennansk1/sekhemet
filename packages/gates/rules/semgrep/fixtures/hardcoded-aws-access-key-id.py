import os

import boto3

# ruleid: sekhemet.hardcoded-aws-access-key-id
AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"


def client():
    return boto3.client(
        "s3",
        # ruleid: sekhemet.hardcoded-aws-access-key-id
        aws_access_key_id="ASIAY34FZKBOKMUTVV7A",
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )


# ok: sekhemet.hardcoded-aws-access-key-id
KEY_ID = os.environ["AWS_ACCESS_KEY_ID"]
# ok: sekhemet.hardcoded-aws-access-key-id
SHORT = "AKIA1234"
# ok: sekhemet.hardcoded-aws-access-key-id
LOWER = "AKIAiosfodnn7example"
