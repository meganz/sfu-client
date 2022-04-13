./genCommitId.sh
cd src
echo "==== Installing/updating build tools... ===="
npm install
echo "==== Building... ===="
npm run build
echo "==== Build finished successfully ===="
