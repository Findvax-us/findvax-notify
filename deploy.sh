#!/usr/bin/env bash

MYDIR=$(cd $(dirname $0) && pwd)

BUILD_TARGET_DIR=$MYDIR/build
BUILD_TMP_DIR=$MYDIR/build/tmp

rm -r $BUILD_TARGET_DIR
mkdir -p $BUILD_TMP_DIR

# i liek to copypasta

echo "----------------------------"
echo " copying files to build tmp"
echo "----------------------------"
cp -r $MYDIR/*.js $BUILD_TMP_DIR
cp -r $MYDIR/node_modules $BUILD_TMP_DIR


echo "----------------------------"
echo "       building .zip"
echo "----------------------------"
cd $BUILD_TMP_DIR
zip -rX $BUILD_TARGET_DIR/notify.zip *  -x "*/\.DS_Store"

echo "----------------------------"
echo "      updating lambda"
echo "----------------------------"
aws lambda update-function-code\
    --profile findvax\
    --function-name notify\
    --zip-file "fileb://$BUILD_TARGET_DIR/notify.zip"\
    --output json \
  | jq -r '.LastUpdateStatus'