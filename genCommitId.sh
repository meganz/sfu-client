#!/bin/bash
commitId=$(git rev-parse --short=10 HEAD)
if [ "$?" != "0" ]; then
    commitId="<unknown>"
fi

if [ -e "./shared/commitId.ts" ]; then
    curr=`sed -rn 's/.*COMMIT_ID\s*=\s*\x27(.+)\x27.*/\1/p' ./shared/commitId.ts`
    if [ "$curr" == "$commitId" ]; then
      # echo "commitId.ts is up to date"
        exit 0
    fi
fi
echo "Generating commitId.ts with commit hash '$commitId'"
echo -e "const COMMIT_ID = '$commitId';\nexport default COMMIT_ID;" > ./shared/commitId.ts
