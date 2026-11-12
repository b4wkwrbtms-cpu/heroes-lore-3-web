import webpack from "webpack";
import { merge } from "webpack-merge";

// @ts-ignore: allowImportingTsExtensions
import commonConfig from "./webpack.config.common.ts";

const config: webpack.Configuration = merge(commonConfig, {
  mode: "production",
  devtool: "hidden-source-map",
});

export default config;
