/*
 * ------------------------------------------------------------------------
 *
 *      _____ _ _  _      _____ _             _       ____        _   
 *     |  __ (_| || |    / ____| |           | |     |  _ \      | |  
 *     | |__) _| || |_  | (___ | |_ ___   ___| | __  | |_) | ___ | |_ 
 *     |  ___| |__   _|  \___ \| __/ _ \ / __| |/ /  |  _ < / _ \| __|
 *     | |   | |  | |    ____) | || (_) | (__|   <   | |_) | (_) | |_ 
 *     |_|   |_|  |_|   |_____/ \__\___/ \___|_|\_\  |____/ \___/ \__|
 *
 *
 *
 * Author:      Logan S. ~ EthyMoney#5000(Discord) ~ EthyMoney(GitHub)
 * Program:     Adafruit Pi4 Stock Bot
 * GitHub:      https://github.com/EthyMoney/Adafruit-Pi4-Stock-Bot
 *
 * Discord and Slack bot that sends alerts of stock of the Raspberry Pi 4 on Adafruit.com
 *
 * No parameters on start. Ensure config.json is configured correctly prior to running.
 *
 * If you find this helpful, consider donating to show support :)
 * ETH address: 0x169381506870283cbABC52034E4ECc123f3FAD02
 *
 *
 *                        Hello from Minnesota USA!
 *                              ⋆⁺₊⋆ ☾ ⋆⁺₊⋆
 *
 * ------------------------------------------------------------------------
*/



// -------------------------------------------
// -------------------------------------------
//
//           SETUP AND DECLARATIONS
//
// -------------------------------------------
// -------------------------------------------

const { MessageEmbed, Client, Intents, ShardClientUtil, Permissions } = require('discord.js');
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES], shards: 'auto' });
const axios = require('axios').default;
const jsdom = require('jsdom');
const chalk = require('chalk');
const fs = require('fs');
const { JSDOM } = jsdom;
const clientShardHelper = new ShardClientUtil(client);
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
let configuredGuild;       // the discord guild to send the stock status to (gets initialized in the ready event)

// flags indicating current stock status of each model (used to prevent sending the same in-stock messages multiple times)
let oneGigNoMMCActive = false;
let twoGigNoMMCActive = false;
let twoGig8GBMMCActive = false;
let twoGig16GBMMCActive = false;
let fourGig32GBMMCActive = false;

// flag indicating if the bot is currently suspended from making queries to Adafruit.com (sleep mode to not query outside of their restock hours)
let sleepModeActive = false;

// check that at least one bot is enabled and complain to the user if not
if (!config.enableDiscordBot && !config.enableSlackBot) {
  console.log(chalk.red('\n[ERROR]') + ' At least one bot must be enabled in config.json. Please enable the bot(s) you want to use and ensure they are configured properly. Exiting...');
  console.log(chalk.yellow('See the README.md for more information if you need help.\n'));
  process.exit(1);
}

// connect to discord (if discord bot is enabled)
if (config.enableDiscordBot) client.login(config.discordBotToken);

// schedule the stock status update to be called at the specified interval
setInterval(() => { checkStockStatus(); }, config.updateIntervalSeconds * 1000);

// show a startup message so the user knows the bot is running (if only using the Slack bot)
if (!config.enableDiscordBot) {
  console.log(chalk.green(chalk.yellow('\n[BOT START]') + ' I\'m watching for stock updates now! I\'ll check Adafruit every ' + chalk.cyan(config.updateIntervalSeconds) + ' seconds...\n'));
}



// -------------------------------------------
// -------------------------------------------
//
//          DISCORD EVENT HANDLERS
//
// -------------------------------------------
// -------------------------------------------

// runs once the discord bot has logged in and is ready to send messages
// this is when we want to do our discord setup tasks and make an initial stock status check

client.on('ready', () => {
  console.log(chalk.greenBright(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} servers while using ${clientShardHelper.count} shard(s)!`));
  // set the bot's presence
  client.user.setActivity('for Pis!', { type: 'WATCHING' });
  // get the discord guild to send the stock status to
  try {
    configuredGuild = client.guilds.cache.get(config.discordServerID);
  }
  catch (err) {
    console.error(chalk.red(`Error looking up guild with provided ID ${config.discordServerID}\n:`), err);
    // since the guild wasn't found, we need to exit here because the rest of the discord abilities will not work and simply crash the bot when they get called
    // the user needs to either fix the configured ID, or disable the discord bot
    process.exit(1);
  }
  // verify and set up the configured discord server if it's not already set up
  setupDiscordServer();
  // run a stock status check on startup (will run on configured interval after this)
  checkStockStatus();
});



// -------------------------------------------
// -------------------------------------------
//
//              CORE FUNCTIONS
//
// -------------------------------------------
// -------------------------------------------

// function to query the Adafruit website for the stock stats of all models of the Raspberry Pi 4 Model B

function checkStockStatus() {
  // if sleep mode is enabled in config.json, this will only check stock status between 6am to 8pm (CDT) (11am to 1am UTC)
  // the website is only likely to be updated between these times so we don't need to spam Adafruit's servers overnight
  if (config.enableSleepMode) {
    const currentTime = new Date();
    const currentHourUTC = currentTime.getUTCHours();
    if (currentHourUTC >= 1 && currentHourUTC < 11) {
      if (!sleepModeActive) {
        sleepModeActive = true;
        console.log(chalk.yellow('Sleeping mode is now active, we\'ll not check stock status outside of Adafruit\'s hours!'));
      }
      return;
    }
    else if (!(currentHourUTC >= 1 && currentHourUTC < 11) && sleepModeActive) {
      sleepModeActive = false;
      console.log(chalk.green('Sleeping mode is now disabled, I\'m actively checking stock status again!'));
    }
  }

  // proceed to make a query to the Pi Compute Module 4 product page and download the source HTML
  axios.get('https://www.adafruit.com/product/4791')
    .then(function (response) {
      // on success, select the HTML from the response and parse it into a DOM object
      const html = response.data;
      const dom = new JSDOM(html);

      // query the DOM to get all of the HTML list <li> elements that contain the stock status for each model
      const stockList = dom.window.document.querySelector('div.mobile-button-row:nth-child(1) > div:nth-child(1) > ol:nth-child(2)').querySelectorAll('li');

      // gather the stock status of each model (represented as a boolean for being in-stock or not)
      // check if the text doesn't contain the text "Out of Stock" (will be showing the price instead if it's actually in stock)
      let oneGigModelInStock = stockList[0].textContent.toLowerCase().indexOf('out of stock') === -1;
      let twoGigNoMMCModelInStock = stockList[1].textContent.toLowerCase().indexOf('out of stock') === -1;
      let twoGig8GigMMCInStock = stockList[2].textContent.toLowerCase().indexOf('out of stock') === -1;
      let twoGig16GigMMCInStock = stockList[3].textContent.toLowerCase().indexOf('out of stock') === -1;
      let fourGigModelInStock = stockList[4].textContent.toLowerCase().indexOf('out of stock') === -1;

      // verify that the stock status of each model has changed since the last check and update the active flags (prevents duplicate notifications)
      checkForNewStock(oneGigModelInStock, twoGigNoMMCModelInStock, twoGig8GigMMCInStock, twoGig16GigMMCInStock, fourGigModelInStock, (adjustedOneGig, adjustedTwoGigNoMMC, adjustedTwoGig8GigMMC, adjustedTwoGig16GigMMC, adjustedFourGig,) => {
        oneGigModelInStock = adjustedOneGig;
        twoGigNoMMCModelInStock = adjustedTwoGigNoMMC;
        twoGig8GigMMCInStock = adjustedTwoGig8GigMMC;
        twoGig16GigMMCInStock = adjustedTwoGig16GigMMC;
        fourGigModelInStock = adjustedFourGig;
      });

      // send the stock status to discord and/or slack if any of the models are in stock
      if (oneGigModelInStock || twoGigNoMMCModelInStock || twoGig8GigMMCInStock || twoGig16GigMMCInStock || fourGigModelInStock) {
        console.log(chalk.yellowBright(`WE GOT STOCK! : ${oneGigModelInStock ? 'CM4 1GB (No MMC, No WiFi)' : ''} ${twoGigNoMMCModelInStock ? 'CM4 2GB (No MMC)' : ''} ${twoGig8GigMMCInStock ? 'CM4 2GB (8GB MMC)' : ''} ${twoGig16GigMMCInStock ? 'CM4 2GB (16GB MMC)' : ''} ${fourGigModelInStock ? 'CM4 4GB (32GB MMC)' : ''}`));
        if (config.enableDiscordBot) {
          sendToDiscord(oneGigModelInStock, twoGigNoMMCModelInStock, twoGig8GigMMCInStock, twoGig16GigMMCInStock, fourGigModelInStock);
        }
        if (config.enableSlackBot) {
          sendToSlack(oneGigModelInStock, twoGigNoMMCModelInStock, twoGig8GigMMCInStock, twoGig16GigMMCInStock, fourGigModelInStock);
        }
      }
    })
    .catch(function (error) {
      console.error(chalk.red('An error occurred during the status refresh:\n'), error);
    });
}


//------------------------------------------
//------------------------------------------

// this function handles verifying the servers, channels, and roles for discord, then sending the actual notification message out
// this will send *one* notification message embed that contains all models that are in stock, rather than separate messages for each model (like the slack function does)

function sendToDiscord(oneGigModelInStock, twoGigNoMMCModelInStock, twoGig8GBMMCModelInStock, twoGig16GBMMCActive, fourGigModelInStock) {
  console.log(chalk.greenBright('Sending stock status to Discord...'));
  let mentionRolesMessage = ''; // will be populated with the roles to mention based on status of each model
  // grab the roles and channels cache from the configured guild
  const rolesCache = configuredGuild.roles.cache;
  const channelsCache = configuredGuild.channels.cache;

  // create the template embed to send to discord
  const embed = new MessageEmbed()
    .setTitle('Adafruit Raspberry Pi 4 IN STOCK!')
    .setDescription('The following models are in stock:\n')
    .setColor('#00ff00')
    .setThumbnail('https://cdn-shop.adafruit.com/970x728/4292-06.jpg')
    .setTimestamp()
    .setFooter({
      text: 'github.com/EthyMoney/Adafruit-Pi4-Stock-Bot',
      iconURL: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'
    });

  // populate stock fields for all in-stock models where notification is enabled in the config
  if (oneGigModelInStock && config.watch1GigModel) {
    embed.addField('1GB Model', '[BUY IT!](https://www.adafruit.com/product/4782)', true);
    const oneGigRole = rolesCache.find(role => role.name === 'CM4 1GB');
    mentionRolesMessage += (oneGigRole) ? ` ${oneGigRole} ` : console.error(chalk.red('No 1GB role found!'));
  }
  if (twoGigNoMMCModelInStock && config.watch2GigNoMMCModel) {
    embed.addField('2GB (No MMC) Model', '[BUY IT!](https://www.adafruit.com/product/4788)', true);
    const twoGigNoMMCRole = rolesCache.find(role => role.name === 'CM4 2GB (No MMC)');
    mentionRolesMessage += (twoGigNoMMCRole) ? ` ${twoGigNoMMCRole} ` : console.error(chalk.red('No CM4 2GB (No MMC) role found!'));
  }
  if (twoGig8GBMMCModelInStock && config.watch2Gig8GigMMCModel) {
    embed.addField('2GB (8GB MMC) Model', '[BUY IT!](https://www.adafruit.com/product/4790)', true);
    const twoGig8GBMMCRole = rolesCache.find(role => role.name === 'CM4 2GB (16GB MMC)');
    mentionRolesMessage += (twoGig8GBMMCRole) ? ` ${twoGig8GBMMCRole} ` : console.error(chalk.red('No CM4 2GB (8GB MMC) role found!'));
  }
  if (twoGig16GBMMCActive && config.watch2Gig16GigMMCModel) {
    embed.addField('2GB (16GB MMC) Model', '[BUY IT!](https://www.adafruit.com/product/4791)', true);
    const twoGig16GBMMCRole = rolesCache.find(role => role.name === 'CM4 2GB (8GB MMC)');
    mentionRolesMessage += (twoGig16GBMMCRole) ? ` ${twoGig16GBMMCRole} ` : console.error(chalk.red('No CM4 2GB (16GB MMC) role found!'));
  }
  if (fourGigModelInStock && config.watch4GigModel) {
    embed.addField('4GB Model', '[BUY IT!](https://www.adafruit.com/product/4982)', true);
    const fourGigRole = rolesCache.find(role => role.name === 'CM4 4GB');
    mentionRolesMessage += (fourGigRole) ? ` ${fourGigRole} ` : console.error(chalk.red('No CM4 4GB (32GB MMC) role found!'));
  }


  // lookup the configured discord TEXT channel by name and send the embed out to the channel
  const channel = channelsCache.find(channel => channel.name === config.discordChannelName.toString() && channel.type == 'GUILD_TEXT');

  // if the channel was found, send the embed and mention messages
  if (channel) {
    channel.send({ embeds: [embed] })
      .then(() => {
        console.log(chalk.greenBright('Successfully sent notification EMBED to Discord!'));
      })
      .catch(function (reject) {
        console.error(chalk.red(`Error sending EMBED message to server ${chalk.cyan(configuredGuild.name)} with promise rejection: ${reject}`));
      });

    // also mention all the relevant users that have the applicable model roles (if the roles could be found in the server)
    if (mentionRolesMessage && mentionRolesMessage !== '' && mentionRolesMessage !== 'undefined' && typeof mentionRolesMessage !== 'undefined') {
      channel.send(mentionRolesMessage.trim())
        .then(() => {
          console.log(chalk.greenBright('Successfully sent MENTION message to Discord!'));
        })
        .catch(function (reject) {
          console.error(chalk.red(`Error sending MENTION message to server ${chalk.cyan(configuredGuild.name)} with promise rejection: ${reject}`));
        });
    }
  }
  else {
    console.error(chalk.red('No text channel found in server with name: ' + chalk.cyan('"' + config.discordChannelName + '"')), chalk.yellow('Did you delete/rename it? Can I see it? Check your config!'));
  }
}


//------------------------------------------
//------------------------------------------

// function to send stock statuses to Slack for models that are in stock
// this will send each model in stock as separate notification messages if multiple models are in stock at once

async function sendToSlack(oneGigModelInStock, twoGigNoMMCModelInStock, twoGig8GBMMCModelInStock, twoGig16GBMMCModelInStock, fourGigModelInStock) {
  console.log(chalk.greenBright('Sending stock status to Slack...'));
  const url = 'https://slack.com/api/chat.postMessage';
  const authorizationHeader = { headers: { authorization: `Bearer ${config.slackBotToken}` } };
  if (oneGigModelInStock && config.watch1GigModel) {
    const channel = config.slackChannel1GB;
    const username = 'CM4 1GB (NO MMC, NO WIFI) IN STOCK';
    const messageText = '@channel The 1GB (No MMC, No WiFi) model is in stock on Adafruit! <https://www.adafruit.com/product/4295|BUY IT>';
    postMessage(channel, username, messageText, '1GB');
  }
  if (twoGigNoMMCModelInStock && config.watch2GigNoMMCModel) {
    const channel = config.slackChannel2GBNoMMC;
    const username = 'CM4 2GB (NO MMC) IN STOCK';
    const messageText = '@channel The 2GB CM4 (No MMC) model is in stock on Adafruit! <https://www.adafruit.com/product/4292|BUY IT>';
    postMessage(channel, username, messageText, '2GB CM4 (No MMC)');
  }
  if (twoGig8GBMMCModelInStock && config.watch2Gig8GigMMCModel) {
    const channel = config.slackChannel2GB8GBMMC;
    const username = 'CM4 2GB (8GB MMC) IN STOCK';
    const messageText = '@channel The 2GB CM4 (8GB MMC) model is in stock on Adafruit! <https://www.adafruit.com/product/4296|BUY IT>';
    postMessage(channel, username, messageText, '2GB CM4 (8GB MMC)');
  }
  if (twoGig16GBMMCModelInStock && config.watch2Gig16GigMMCModel) {
    const channel = config.slackChannel2GB16GBMMC;
    const username = 'CM4 2GB (16GB MMC) IN STOCK';
    const messageText = '@channel The 2GB CM4 (16GB MMC) model is in stock on Adafruit! <https://www.adafruit.com/product/4564|BUY IT>';
    postMessage(channel, username, messageText, '2GB CM4 (16GB MMC)');
  }
  if (fourGigModelInStock && config.watch4GigModel) {
    const channel = config.slackChannel4GB;
    const username = 'CM4 4GB (32GB MMC) IN STOCK';
    const messageText = '@channel The 4GB CM4 (32GB MMC) model is in stock on Adafruit! <https://www.adafruit.com/product/4564|BUY IT>';
    postMessage(channel, username, messageText, '4GB (32GB MMC)');
  }

  // nested function to post the message(s) (called for each model)
  async function postMessage(channel, username, messageText, model) {
    await axios.post(url, {
      channel: channel,
      username: username,
      link_names: true,
      text: messageText
    }, authorizationHeader)
      .then(() => {
        console.log(chalk.greenBright(`Successfully sent ${model} stock status to Slack!`));
      })
      .catch(function (reject) {
        console.error(chalk.red(`Error sending ${model} stock status to Slack with promise rejection: ${reject}`));
      });
  }
}



// -------------------------------------------
// -------------------------------------------
//
//             UTILITY FUNCTIONS
//
// -------------------------------------------
// -------------------------------------------

// function that runs on startup to set up the configured discord server with the necessary roles and a notification channel to post in

function setupDiscordServer() {
  // first, define the roles we need in the server based on the config (in RGB cus we're real gamers here)
  const roles = [];
  if (config.watch1GigModel) roles.push({ name: 'CM4 1GB', color: 'RED' });
  if (config.watch2GigNoMMCModel) roles.push({ name: 'CM4 2GB (No MMC)', color: 'GREEN' });
  if (config.watch2Gig8GigMMCModel) roles.push({ name: 'CM4 2GB (8GB MMC)', color: 'BLUE' });
  if (config.watch2Gig16GigMMCModel) roles.push({ name: 'CM4 2GB (16GB MMC)', color: 'PURPLE' });
  if (config.watch4GigModel) roles.push({ name: 'CM4 4GB', color: 'YELLOW' });

  // create the roles in the server if they don't exist yet
  roles.forEach(role => {
    if (!configuredGuild.roles.cache.find(r => r.name == role.name)) {
      configuredGuild.roles.create({ name: role.name, color: role.color })
        .then(role => {
          console.log(chalk.green(`Created role: ${role.name}`));
        })
        .catch(err => {
          console.error(chalk.red(`Error creating role: ${role.name}\n:`), err);
        });
    }
  });
  // create the notification channel if an existing one wasn't specified in the config (this will also trigger if configured channel is misspelled or in wrong case in config file)
  if (!configuredGuild.channels.cache.find(c => c.name == config.discordChannelName)) {
    configuredGuild.channels.create('cm4-stock-notifications', {
      type: 'GUILD_TEXT',
      permissionOverwrites: [
        {
          id: client.user.id,
          allow: [Permissions.FLAGS.EMBED_LINKS, Permissions.FLAGS.SEND_MESSAGES, Permissions.FLAGS.VIEW_CHANNEL]
        },
      ],
    })
      .then(channel => {
        // set the notification channel in the config to be this new one (so it can be used in the future)
        config.discordChannelName = 'cm4-stock-notifications';
        fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
        console.log(chalk.green('You didn\'t provide a channel name or it wasn\'t able to be found in the server, so I created one for you!'));
        console.log(chalk.green(`The new channel is named: ${chalk.cyan(channel.name)}`));
      })
      .catch(err => {
        console.error(
          chalk.red('Error creating default notification channel, either set the correct one in your config or correct what is preventing me from doing it (likely a permissions issue)\n'), err);
      });
  }
  console.log(chalk.greenBright(`Discord server setup complete for ${chalk.cyan(configuredGuild.name)}  Lets go! ⚡⚡⚡`));
  console.log(chalk.green('\nI\'m watching for stock updates now! I\'ll check Adafruit every ' + chalk.cyan(config.updateIntervalSeconds) + ' seconds...\n'));
}


//------------------------------------------
//------------------------------------------

// check new statuses against the old cached ones to see if any models have come in stock that weren't previously
// this is done so we don't send another notification for a model that has already had a notification sent for it
// the active status flags get reset when the models go out of stock again so that the next restock will be captured

function checkForNewStock(oneGigModelInStock, twoGigNoMMCModelInStock, twoGig8GBMMCModelInStock, twoGig16GBMMCModelInStock, fourGigModelInStock, cb) {
  // first, ignore if in stock but has already had notification sent (active)
  if (oneGigModelInStock && oneGigNoMMCActive) {
    oneGigModelInStock = false;
  }
  else {
    // in stock and wasn't previously, send a notification and update the active status flag
    if (oneGigModelInStock && !oneGigNoMMCActive) {
      oneGigNoMMCActive = true;
    }
    if (!oneGigModelInStock && oneGigNoMMCActive) {
      oneGigNoMMCActive = false;
    }
  }
  if (twoGigNoMMCModelInStock && twoGigNoMMCActive) {
    twoGigNoMMCModelInStock = false;
  }
  else {
    if (twoGigNoMMCModelInStock && !twoGigNoMMCActive) {
      twoGigNoMMCActive = true;
    }
    if (!twoGigNoMMCModelInStock && twoGigNoMMCActive) {
      twoGigNoMMCActive = false;
    }
  }
  if (twoGig8GBMMCModelInStock && twoGig8GBMMCActive) {
    twoGig8GBMMCModelInStock = false;
  }
  else {
    if (twoGig8GBMMCModelInStock && !twoGig8GBMMCActive) {
      twoGig8GBMMCActive = true;
    }
    if (!twoGig8GBMMCModelInStock && twoGig8GBMMCActive) {
      twoGig8GBMMCActive = false;
    }
  }
  if (twoGig16GBMMCModelInStock && twoGig16GBMMCActive) {
    twoGig16GBMMCModelInStock = false;
  }
  else {
    if (twoGig16GBMMCModelInStock && !twoGig16GBMMCActive) {
      twoGig16GBMMCActive = true;
    }
    if (!twoGig16GBMMCModelInStock && twoGig16GBMMCActive) {
      twoGig16GBMMCActive = false;
    }
  }
  if (fourGigModelInStock && fourGig32GBMMCActive) {
    fourGigModelInStock = false;
  }
  else {
    if (fourGigModelInStock && !fourGig32GBMMCActive) {
      fourGig32GBMMCActive = true;
    }
    if (!fourGigModelInStock && fourGig32GBMMCActive) {
      fourGig32GBMMCActive = false;
    }
  }

  // return the updated statuses
  cb(oneGigModelInStock, twoGigNoMMCModelInStock, twoGig8GBMMCModelInStock, twoGig16GBMMCModelInStock, fourGigModelInStock);
}


//
// welcome to the end, want a cookie?  ༼ つ ◕_◕ ༽つ🍪
//
