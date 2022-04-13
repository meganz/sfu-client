const webpack = require('webpack');

module.exports = {
    entry: {
        'sfuClient.bundle': './client.ts',
        'worker.sfuClient.bundle': './clientCryptoWorker.ts'
    },
    mode: 'production',
    optimization: {
        minimize: false
    },
    // devtool: 'source-map',
    plugins: [
        new webpack.BannerPlugin({
            raw: true,
            banner: "/** @file automatically generated, do not edit it. */\n/* eslint-disable max-len, no-eq-null */"
        })
    ],
    module: {
        rules: [
            {
                test: /\.ts?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    output: {
        filename: '[name].js',
        path: __dirname
    },
};