#!/bin/sh
# The fixture instance's setup hook. It records only that it ran and its
# argument count, outside the test's HOME.
echo "setup $#" >>"${STUB_STATE:?}/calls"
