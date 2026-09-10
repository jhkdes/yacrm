// Real past outbound LinkedIn messages the user actually sent, hand-picked
// (from scripts/list-voice-candidates.ts's output) to span what campaign
// drafts need to do: a casual reconnect, cold referral asks, a cold invite,
// and messages that share a link. Spliced verbatim into the drafting
// prompt (see buildDraftPrompt in draft-generation.ts) so the model
// matches the user's real voice instead of an invented persona — see
// docs/... "Ground campaign drafts in the user's real voice".
export const USER_VOICE_EXAMPLES: string[] = [
  `Hey Victor,

How are you? Long time no talk. It looks like you've started wealth management service of your own. Congrats!

Since Actiance, I have stayed in tech, and currently at Egnyte which provides compliant file storage for financial services industry, among others.

When you have free time, let's catch up. I'm generally available Friday afternoon.

Cheers,
-Jae`,

  `Hi Daren - hope you've been doing well! It's been a long time since we worked together, but I saw that you're at Celigo now.

I recently applied for the Senior Director, Product Management role and immediately thought of reaching out. Over the past several years, I've been leading enterprise B2B product teams at Meta, BlackBerry, and most recently Egnyte, where I've been focused on AI, integrations, and ecosystem strategy.

If you think my background could be a good fit, would you be comfortable referring me or pointing the recruiter to my application? I'd really appreciate it. Happy to send over my resume or jump on a quick call if it'd be helpful.

Hope all is well, and it'd be great to reconnect!

Cheers,
-Jae`,

  `Hi Hari - hope you're doing well!

I saw the Product Director, Enterprise Data Cloud opening at Everpure and it caught my eye. I just applied online, and wanted to reach out because I really enjoyed working with you at Egnyte, especially getting the email filing initiative off the ground together for AEC. Excited to see it's about to go GA in September!

If you think I'd be a good fit for the team, would you be willing to recommend me or put in a good word with the hiring team? I'd really appreciate it.

Hope you're still getting plenty of miles in—would be great to catch up sometime!

Regards,
-Jae`,

  `Hi Andrew - how are you?

While thinking of my time at the Shobhit's EJS program, I thought of reaching out to you.

I would like to reconnect, and catch up on what you've been up to, and share a bit about what I'm experimenting with. Can we find time to chat?

Fee free to find time to reconnect on my Calendly: https://calendly.com/jaeho9kim

Looking forward to catching up.

Regards,
-Jae`,

  `Hi Greg, it was good connecting with you the other day. Thanks for sharing OC Product. Listening to Rich's preso about speaking CRO's language resonates quite a bit.
As mentioned, I'm working on AI interviewer to study AI usage among PMs. If you can spare 15 mins to try, I would be thrilled. Here is the interview link: https://user-interviewer.vercel.app/interview/ZxbIW8wm-iflSOOvX5sAMlly5Xsbrjfp

Cheers,
-Jae`,

  `Hi Betty - how are you?

It's been a while I saw you at ProductTank. Hope you are well. I didn't realize that you are now at Vapi. I've been using Vapi to build my prototype, and evaluating whether to move to Elevenlabs for production.

If you have a spare moment, I would love to catch up with you to learn the Vapi direction, and share a bit about what I'm building.

Feel free to grab time on my calendar: https://calendly.com/jaeho9kim

Cheers,
-Jae`,

  `Hi Justin,

Thanks for connecting. I've been following Box's AI work closely from my role at Egnyte, where I'm focused on the future of content management and AI.

One of the open Product roles caught my attention. I have 15+ years in enterprise B2B product management across Egnyte, Meta, BlackBerry, and as a founder, building collaboration, integrations, and AI-driven platforms.

I'm currently looking for a hands-on individual contributor role where I can move fast, stay close to customers, and drive high-impact outcomes. While my background is at the Director level, I'm intentionally targeting builder roles with strong scope and ownership.

If my background seems relevant, I'd welcome the opportunity to schedule a brief call to learn more about the team and discuss where I might be a fit at Box. Please let me know if you have time in the coming weeks.

Cheers,
-Jae`,
];
