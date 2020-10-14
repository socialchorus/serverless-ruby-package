'use strict';

const path = require("path");
const { execSync } = require('child_process');
const fs = require('fs');

class PackageRubyBundlePlugin {
  get config() {
    const config = Object.assign(
      {
        alwaysCrossCompileExtensions: true,
        debug: !!process.env.SRP_DEBUG,
        // The path to the gemfile to use for bundling
        gemfilePath: path.join(this.serverless.config.servicePath, "Gemfile"),
        // The name of the temporary docker container that will be used for bundling.
        containerName: 'serverless-ruby-package.packaged-gems',
        containerPath: '/var/task',
        // A list of bundle groups to disinclude from the bundle
        withoutGroups: 'test development deploy',
        // A list of bundle groups to include in the bundle
        withGroups: false,
        // Whether to bundle as standalone
        standalone: false,
        // name of the docker image to use to compile gems
        dockerImage: false,
        // Make the assumption that anything in a gem under /spec or /test can be excluded from the package.
        excludeGemTests: true,
      },
      (
        this.serverless.service.custom &&
        this.serverless.service.custom.rubyPackage
      ) || {}
    );
    // give precedence to environment variable, if set
    if (typeof(process.env.CROSS_COMPILE_EXTENSIONS) !== 'undefined'){
      const override = (/^(?:y|yes|true|1|on)$/i.test(process.env.CROSS_COMPILE_EXTENSIONS));
      config.alwaysCrossCompileExtensions = override;
    }

    return config;
  }

  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      'before:package:createDeploymentArtifacts': this.beforePackage.bind(this),
      'before:package:function:package': this.beforePackage.bind(this),
    };
  }

  log(message){
    this.serverless.cli.log(message, "ruby-package");
  }

  rubyVersion() {
    // RbConfig::CONFIG['ruby_version']
    switch (this.serverless.service.provider.runtime) {
      case 'ruby2.5':
        return '2.5.0';
      default:
        return '2.7.0';
    }
  }

  extensionApiVersion() {
    // Gem.extension_api_version
    switch (this.serverless.service.provider.runtime) {
      case 'ruby2.5':
        return '2.5.0-static';
      default:
        return '2.7.0';
    }
  }

  beforePackage(){
    this.warnOnUnsupportedRuntime();

    const gemRoot = `vendor/bundle/ruby/${this.rubyVersion()}`;
    const extensionDir = `${gemRoot}/extensions/x86_64-linux/${this.extensionApiVersion()}`;

    const identifyGemsScript = `
      require 'json'
      root = ENV['GEM_HOME']
      gems = Bundler.definition.specs_for([:default]).reject{|s| s.name=='bundler'}
      details = gems.map{|gem|
        {
          extensions: !!gem.extensions.any?,
          name: gem.full_name,
          path: gem.full_gem_path.split(root).last,
          gemspec: gem.loaded_from.split(root).last,
        }
      }
      puts JSON.generate(details.sort_by{|x| x[:name]})
    `

    this.serverless.service.package.excludeDevDependencies = false; // only relevant to nodejs

    // Force the `serverless package` command to exclude all files from the package except whitelisted files.
    this.serverless.service.package.exclude = ["**"];

    if (this.config.standalone) {
      this.serverless.service.package.include.push("vendor/bundle/bundler/**"); // bundler standalone files
    }

    const bundleEnv = Object.assign({ "BUNDLE_GEMFILE": this.config.gemfilePath }, process.env);
    const output = execSync("bundle exec ruby", {input: identifyGemsScript, env: bundleEnv});
    const gems = JSON.parse(output)

    // TODO:
    //    Not checking for extensions because we're using the bundle install to create the bundle config too
    //    Update this package so that bundle config and cross compilation are separate parts of the process

    // if (gems.some(x=>x.extensions)){
    if (this.config.alwaysCrossCompileExtensions){
      this.nativeLinuxBundle();
    }
    // }

    if (gems.length < 10) {
      this.log(`Packaging gems: ${gems.map(x=>x.name).join(" ")}`);
    } else {
      this.log(`Packaging ${gems.length} gems`);
    }

    // Bundler.setup (non standalone mode) uses the .bundle/config for configuration of the runtime bundle
    if (!this.config.standalone) {
      if (this.config.debug) this.log("Compiling bundle in bundler/setup mode")
      this.serverless.service.package.include.push('.bundle/config');
    } else {
      if (this.config.debug) this.log("Compiling bundle in standalone mode")
    }

    gems.forEach((gem) =>{
      this.serverless.service.package.include.push(`${gemRoot}${gem.path}/**`);

      if (gem.extensions){
        this.serverless.service.package.include.push(`${extensionDir}/${gem.name}/**`);
      }

      // includes that start with a ! are treated as excludes when evaluating,
      // but are ordered along with the includes. If these patterns were
      // specified as excludes, they would be evaluated first, and then the
      // includes on the gem paths would bring them back.
      this.serverless.service.package.include.push(`!${gemRoot}${gem.path}/.git/**`);
      if (this.config.excludeGemTests) {
        this.serverless.service.package.include.push(`!${gemRoot}${gem.path}/test/**`);
        this.serverless.service.package.include.push(`!${gemRoot}${gem.path}/spec/**`);
      }

      // Standalone mode assumes the app will load a file at vendor/bundle/bundler/setup.rb and will
      // not use bundler/setup.
      // Bundler.setup (non standalone mode) requires the presence of the gemspecs in the package and
      // the .bundle/config file used by the app.
      if (!this.config.standalone) {
        this.serverless.service.package.include.push(`${gemRoot}${gem.gemspec}`);
      }
    });

    if (this.config.debug) {
      this.log('Filepaths whitelisted in the packaging')
      this.serverless.service.package.include.forEach((fp) => {
        this.log(`--- ${fp}`)
      });
    }
  }

  tempContainer() {
    if (this.config.tempContainer) { return this.config.tempContainer; }

    const container = {
      name: this.config.containerName,
      path: this.config.containerPath,
      image: this.config.dockerImage,
    }

    if (!container.image) {
      switch (this.serverless.service.provider.runtime) {
        case 'ruby2.5':
          container.image = 'lambci/lambda:build-ruby2.5';
          break;
        default:
          container.image = 'lambci/lambda:build-ruby2.7';
          break;
      }
    }

    this.config.tempContainer = container;
    return container;
  }

  nativeLinuxBundle(){
    this.log(`Building gems with native extensions for linux`);
    const localPath = this.serverless.config.servicePath;
    const tempContainer = this.tempContainer()

    if (this.config.debug){
      this.log(`container name: ${tempContainer.name}`);
      this.log(`docker image: ${tempContainer.image}`);
    }

    try {
      execSync(`docker create -v ${tempContainer.path} --name ${tempContainer.name} ${tempContainer.image} /bin/true`)

      // Only copy over what we need
      execSync(`if [ -d "${localPath}/vendor" ]; then
        docker cp ${localPath}/vendor ${tempContainer.name}:${tempContainer.path}/vendor
        fi
      `)
      execSync(`docker cp ${this.config.gemfilePath} ${tempContainer.name}:${tempContainer.path}/Gemfile`)
      execSync(`docker cp ${this.config.gemfilePath}.lock ${tempContainer.name}:${tempContainer.path}/Gemfile.lock`)

      // Configure the bundle
      const dockerRun = `docker run --rm --volumes-from ${tempContainer.name} ${tempContainer.image}`;
      execSync(`${dockerRun} bundle config set --local path 'vendor/bundle'`)
      execSync(`${dockerRun} bundle config set --local deployment 'true'`)
      execSync(`${dockerRun} bundle config set --local frozen 'true'`)
      execSync(`${dockerRun} bundle config set --local clean 'true'`)
      if (this.config.withGroups) {
        execSync(`${dockerRun} bundle config set --local with '${this.config.withGroups}'`)
      }
      if (this.config.withoutGroups) {
        execSync(`${dockerRun} bundle config set --local without '${this.config.withoutGroups}'`)
      }
      if (this.config.standalone) {
        execSync(`${dockerRun} bundle config set --local standalone 'true'`)
      }

      const result = execSync(`${dockerRun} bundle install`)
      if (this.config.debug) { this.log(result) }

      // Copy files back to the host
      execSync(`docker cp ${tempContainer.name}:${tempContainer.path}/vendor ${localPath}`)

      if (!this.config.standalone) {
        execSync(`docker cp ${tempContainer.name}:${tempContainer.path}/.bundle ${localPath}`)
      }
    } finally {
      execSync(`docker rm ${tempContainer.name}`)
    }
  }

  warnOnUnsupportedRuntime(){
    if (this.config.debug){
      this.log(`platform: ${process.platform}`);
      this.log(`provider: ${this.serverless.service.provider.name}`);
      this.log(`runtime: ${this.serverless.service.provider.runtime}`);
    }
    if (this.serverless.service.provider.name != 'aws'){
      this.log(`WARNING: serverless-ruby-package has only been tested with the AWS provider. It may not work with ${this.serverless.service.provider.name}, but bug reports are welcome.`);
      return;
    }
    if (!['ruby2.5', 'ruby2.7'].includes(this.serverless.service.provider.runtime)){
      this.log(`WARNING: serverless-ruby-package has only been tested with the ruby2.5 and the ruby2.7 runtimes. It may not work with ${this.serverless.service.provider.runtime}, but bug reports are welcome.`);
    }
  }
}

module.exports = PackageRubyBundlePlugin;
