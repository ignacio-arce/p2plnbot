const { Scenes } = require('telegraf')
const { isValidInvoice } = require('./validations');
const { Order, Community, User } = require('../models');
const { waitPayment, addInvoice, showHoldInvoice } = require("./commands");
const { getCurrency } = require('../util');

const addInvoiceWizard = new Scenes.WizardScene(
  'ADD_INVOICE_WIZARD_SCENE_ID',
  async (ctx) => {
    try {
      const { bot, buyer, order } = ctx.wizard.state;
      const expirationTime = parseInt(process.env.HOLD_INVOICE_EXPIRATION_WINDOW) / 60;
      const currency = getCurrency(order.fiat_code);
      const symbol = (!!currency && !!currency.symbol_native) ? currency.symbol_native : order.fiat_code;
      await bot.telegram.sendMessage(buyer.tg_id, `Para poder enviarte los satoshis necesito que me envíes una factura con monto ${order.amount} satoshis equivalente a ${symbol} ${order.fiat_amount}`);
      await bot.telegram.sendMessage(buyer.tg_id, `Si no la envías en ${expirationTime} minutos la orden será cancelada`);
      
      order.status = 'WAITING_BUYER_INVOICE';
      await order.save();
      return ctx.wizard.next();
    } catch (error) {
      console.log(error);
      return ctx.reply('Ha ocurrido un error, por favor contacta al administrador');
    }
  },
  async (ctx) => {
    try {
      if (ctx.message === undefined) {
        return ctx.scene.leave();
      }
      const lnInvoice = ctx.message.text;
      let { bot, buyer, seller, order } = ctx.wizard.state;
      if (lnInvoice == 'exit') {
        let message = `Has salido del modo wizard, ahora puedes escribir comandos, aún puedes `;
        message += `ingresar una factura a la orden con el comando /setinvoice indicando Id `;
        message += `de orden y factura, puedes enviarme una factura con un monto de `;
        message += `${order.amount} satoshis, pero tambien acepto facturas sin monto:\n\n`;
        message += `/setinvoice ${order._id} <factura lightning con o sin monto>`;
        await ctx.reply(message);
        return ctx.scene.leave();
      }
      const res = await isValidInvoice(lnInvoice);
      if (!res.success) {
        await ctx.reply(res.error);
        return;
      };
      // We get an updated order from the DB
      order = await Order.findOne({ _id: order._id });
      if (order.status == 'EXPIRED') {
        await ctx.reply(`¡Esta orden ya expiró!`);
        return ctx.scene.leave();
      }

      if (order.status != 'WAITING_BUYER_INVOICE') {
        await ctx.reply(`¡Ya no puedes agregar una factura para esta orden!`);
        return ctx.scene.leave();
      }

      if (res.invoice.tokens && res.invoice.tokens != order.amount) {
        await ctx.reply('La factura tiene un monto incorrecto');
        return;
      }
      await waitPayment(ctx, bot, buyer, seller, order, lnInvoice);

      return ctx.scene.leave();
    } catch (error) {
      console.log(error);
      ctx.scene.leave();
    }
  },
);

const communityWizard = new Scenes.WizardScene(
  'COMMUNITY_WIZARD_SCENE_ID',
  async (ctx) => {
    try {
      if (ctx.message === undefined) {
        return ctx.scene.leave();
      }
      const message = await ctx.reply(
        'Ingresa el nombre de tu comunidad:',
      );
      ctx.wizard.state.community = {};
      ctx.wizard.state.prev_message_id = [message.message_id];
  
      return ctx.wizard.next();
    } catch (error) {
      console.log(error);
      ctx.scene.leave();
    }
  },
  async (ctx) => {
    try {
      if (ctx.message === undefined) {
        return ctx.scene.leave();
      }
  
      const name = ctx.message.text;
      if (name == 'exit') {
        await ctx.reply('Saliendo del modo wizard, ahora podrás escribir comandos.');
        return ctx.scene.leave();
      }

      if (name.length > 20) {
        ctx.deleteMessage();
        const warning = await ctx.reply(
          'El nombre debe tener un máximo de 20 caracteres. Puede editarlo a continuación:'
        );
        const nameTooLong = await ctx.reply(`${name}`);
        ctx.wizard.state.prev_message_id.push(warning.message_id, nameTooLong.message_id);
  
        return;
      }
      ctx.wizard.state.community.name = name;
      const reply = `Ingresa el id o el nombre del grupo de la comunidad, tanto el bot como ` +
      `tú deben ser administradores del grupo:` +
      `\n\nP. ej: @MiComunidad`;
      await ctx.reply(reply);
      return ctx.wizard.next();
    } catch (error) {
      console.log(error);
      ctx.scene.leave();
    }
  },
  async (ctx) => {
    try {
      const { bot, user } = ctx.wizard.state;
      const groupId = ctx.message.text;
      if (groupId == 'exit') {
        await ctx.reply('Has salido del modo wizard, ahora puedes escribir comandos');
        return ctx.scene.leave();
      }
      await isGroupAdmin(groupId, user, bot.telegram);
      ctx.wizard.state.community.groupId = groupId;
      ctx.wizard.state.community.creator_id = user._id;
      const reply = `Las ofertas en tu comunidad deben publicarse en un canal de telegram, ` +
      `si me indicas un canal tanto las compras como las ventas se publicarán en ese canal, ` +
      `si me indicas dos canales se publicaran las compras en uno y las ventas en el otro, ` +
      `tanto el bot como tú deben ser administradores de ambos canales.` +
      `\n\nPuedes ingresar el nombre de un canal o si deseas utilizar dos canales ingresa ` +
      `dos nombres separados por un espacio.` +
      `\n\nP. ej: @MiComunidadCompras @MiComunidadVentas`;
      await ctx.reply(reply);

      return ctx.wizard.next();
    } catch (error) {
      ctx.reply(error.toString());
      ctx.scene.leave();
    }
  },
  async (ctx) => {
    try {
      const { bot, user, community } = ctx.wizard.state;
      if (ctx.message === undefined) {
        return ctx.scene.leave();
      }
      if (ctx.message.text == 'exit') {
        await ctx.reply('Has salido del modo wizard, ahora puedes escribir comandos');
        return ctx.scene.leave();
      }
      const chan = ctx.message.text.split(" ");
      if (chan.length > 2) {
        ctx.reply('Debes ingresar uno o dos canales');
        return;
      }
      community.order_channels = [];
      if (chan.length == 1) {
        await isGroupAdmin(chan[0], user, bot.telegram);
        const channel = {
          name: chan[0],
          type: 'mixed',
        };
        community.order_channels.push(channel);
      } else {
        await isGroupAdmin(chan[0], user, bot.telegram);
        await isGroupAdmin(chan[1], user, bot.telegram);
        const channel1 = {
          name: chan[0],
          type: 'buy',
        };
        const channel2 = {
          name: chan[1],
          type: 'sell',
        };
        community.order_channels.push(channel1);
        community.order_channels.push(channel2);
      }

      ctx.wizard.state.community = community;
      let reply = `Ahora ingresa los username de los usuarios que se encargan de resolver disputas, `;
      reply += `cada username separado por un espacio en blanco`;
      await ctx.reply(reply);

      return ctx.wizard.next();
    } catch (error) {
      ctx.reply(error.toString());
      console.log(error);
    }
  },
  async (ctx) => {
    try {
      const { community } = ctx.wizard.state;
      community.solvers = [];
      const groupId = ctx.message.text;
      if (groupId == 'exit') {
        await ctx.reply('Has salido del modo wizard, ahora puedes escribir comandos');
        return ctx.scene.leave();
      }
      const usernames = ctx.message.text.split(" ");
      if (usernames.length > 0 && usernames.length < 10) {
        for (let i = 0; i < usernames.length; i++) {
          const user = await User.findOne({ username: usernames[i] });
          if (!!user) {
            community.solvers.push(user._id.toString());
          }
        }
      } else {
        await ctx.reply('Debes ingresar uno o dos nombres separados por un espacio');
      }
      ctx.wizard.state.community.solvers = community.solvers;
      let reply = `Para finalizar indícame el id o nombre del canal que utilizará el bot para avisar `;
      reply += `cuando haya una disputa, por favor incluye un @ al inicio del nombre del canal`;
      await ctx.reply(reply);

      return ctx.wizard.next();
    } catch (error) {
      ctx.reply(error.toString());
      ctx.scene.leave();
    }
  },
  async (ctx) => {
    try {
      const { bot, user, community } = ctx.wizard.state;
      const chan = ctx.message.text;
      if (chan == 'exit') {
        await ctx.reply('Has salido del modo wizard, ahora puedes escribir comandos');
        return ctx.scene.leave();
      }
      await isGroupAdmin(chan, user, bot.telegram);
      community.dispute_channel = chan;

      const newCommunity = new Community(community);
      await newCommunity.save();
      await ctx.reply('Felicidades! has creado tu comunidad');
      return ctx.scene.leave();
    } catch (error) {
      ctx.reply(error.toString());
      ctx.scene.leave();
    }
  },
);

const isGroupAdmin = async (groupId, user, telegram) => {
  try {
    const member = await telegram.getChatMember(groupId, parseInt(user.tg_id));
    if (member && (member.status === 'creator' || member.status === 'administrator')) {
      return true;
    }

    return false;
  } catch (error) {
    console.log(error);
    if (!!error.response && error.response.error_code == 400) {
      throw new Error('No tienes permisos de administrador en este grupo o canal');
    }
  }
};

const addFiatAmountWizard = new Scenes.WizardScene(
  'ADD_FIAT_AMOUNT_WIZARD_SCENE_ID',
  async (ctx) => {
    try {
      const { bot, order, caller } = ctx.wizard.state;
      const currency = getCurrency(order.fiat_code);
      const action = order.type === 'buy' ? 'recibir' : 'enviar';
      const currencyName = (!!currency && !!currency.name_plural) ? currency.name_plural : order.fiat_code;
      let message = `Ingresa la cantidad de ${currencyName} que desea ${action}.\n`;
      message += `Recuerde que debe estar entre ${order.min_amount} y ${order.max_amount}:`
      await bot.telegram.sendMessage(caller.tg_id, message);
      return ctx.wizard.next()
    } catch (error) {
      console.log(error);
      return ctx.reply('Ha ocurrido un error, por favor contacta al administrador');
    }
  },
  async (ctx) => {
    try {
      const { bot, order } = ctx.wizard.state;
      const warningMessage = `Ingrese una número entre ${order.min_amount} y ${order.max_amount}`;

      if (ctx.message === undefined) {
        return ctx.scene.leave();
      }

      const fiatAmount = parseInt(ctx.message.text);
      if (!Number.isInteger(fiatAmount)) {
        await ctx.reply(warningMessage);
        return;
      }

      if (fiatAmount < order.min_amount || fiatAmount > order.max_amount) {
        await ctx.reply(warningMessage);
        return;
      }

      order.fiat_amount = fiatAmount;

      const currency = getCurrency(order.fiat_code);

      ctx.reply(`Cantidad elegida: ${currency.symbol_native} ${fiatAmount} .`)
      
      if (order.type == 'sell') {
        await addInvoice(ctx, bot, order);
      } else {
        await showHoldInvoice(ctx, bot, order);
      }

      return ctx.scene.leave();
    } catch (error) {
      console.log(error);
    }
  }
)

module.exports = {
  addInvoiceWizard,
  communityWizard,
  addFiatAmountWizard,
};
